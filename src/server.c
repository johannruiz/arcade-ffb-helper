/* Minimal HTTP + WebSocket (RFC 6455) server bound to 127.0.0.1.
 *   GET /          -> the settings page (Host must be this server: no DNS rebinding)
 *   GET /ws/ui     -> WebSocket for the settings page (same origin only)
 *   GET /ws/game   -> WebSocket for a game page (allow-listed origins only)
 */
#include "server.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <ctype.h>
#include <SDL3/SDL_log.h>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
typedef SOCKET sock_t;
#define BAD_SOCK INVALID_SOCKET
#define sock_close closesocket
#define WOULD_BLOCK() (WSAGetLastError() == WSAEWOULDBLOCK)
#else
#include <sys/socket.h>
#include <sys/select.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
typedef int sock_t;
#define BAD_SOCK (-1)
#define sock_close close
#define WOULD_BLOCK() (errno == EAGAIN || errno == EWOULDBLOCK)
#endif

#define MAX_CLIENTS 16
#define BUF_CAP 65536

typedef struct {
    sock_t s;
    int kind;          /* 0 = HTTP not upgraded yet */
    size_t len;
    unsigned char buf[BUF_CAP];
} Client;

static sock_t listener = BAD_SOCK;
static Client *clients[MAX_CLIENTS];
static ServerConfig cfg;
static unsigned short port_;

/* ---------------- SHA-1 + base64 (for the handshake) ---------------- */
typedef struct { uint32_t h[5]; uint64_t n; unsigned char b[64]; size_t bl; } Sha1;
#define ROL(v, s) (((v) << (s)) | ((v) >> (32 - (s))))
static void sha1_block(Sha1 *c, const unsigned char *p) {
    uint32_t w[80], a = c->h[0], b = c->h[1], d2 = c->h[2], d = c->h[3], e = c->h[4];
    for (int i = 0; i < 16; i++) w[i] = (uint32_t)p[i * 4] << 24 | (uint32_t)p[i * 4 + 1] << 16 | (uint32_t)p[i * 4 + 2] << 8 | p[i * 4 + 3];
    for (int i = 16; i < 80; i++) w[i] = ROL(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    for (int i = 0; i < 80; i++) {
        uint32_t f, k;
        if (i < 20) { f = (b & d2) | (~b & d); k = 0x5A827999; }
        else if (i < 40) { f = b ^ d2 ^ d; k = 0x6ED9EBA1; }
        else if (i < 60) { f = (b & d2) | (b & d) | (d2 & d); k = 0x8F1BBCDC; }
        else { f = b ^ d2 ^ d; k = 0xCA62C1D6; }
        uint32_t t = ROL(a, 5) + f + e + k + w[i];
        e = d; d = d2; d2 = ROL(b, 30); b = a; a = t;
    }
    c->h[0] += a; c->h[1] += b; c->h[2] += d2; c->h[3] += d; c->h[4] += e;
}
static void sha1(const unsigned char *data, size_t len, unsigned char out[20]) {
    Sha1 c = {{0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0}, 0, {0}, 0};
    c.n = (uint64_t)len * 8;
    while (len >= 64) { sha1_block(&c, data); data += 64; len -= 64; }
    unsigned char tail[128] = {0};
    memcpy(tail, data, len);
    tail[len] = 0x80;
    size_t tl = len < 56 ? 64 : 128;
    for (int i = 0; i < 8; i++) tail[tl - 1 - i] = (unsigned char)(c.n >> (8 * i));
    sha1_block(&c, tail);
    if (tl == 128) sha1_block(&c, tail + 64);
    for (int i = 0; i < 5; i++) { out[i * 4] = (unsigned char)(c.h[i] >> 24); out[i * 4 + 1] = (unsigned char)(c.h[i] >> 16); out[i * 4 + 2] = (unsigned char)(c.h[i] >> 8); out[i * 4 + 3] = (unsigned char)c.h[i]; }
}
static void base64(const unsigned char *in, size_t n, char *out) {
    static const char t[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    size_t j = 0;
    for (size_t i = 0; i < n; i += 3) {
        uint32_t v = (uint32_t)in[i] << 16 | (i + 1 < n ? (uint32_t)in[i + 1] << 8 : 0) | (i + 2 < n ? in[i + 2] : 0);
        out[j++] = t[v >> 18 & 63]; out[j++] = t[v >> 12 & 63];
        out[j++] = i + 1 < n ? t[v >> 6 & 63] : '=';
        out[j++] = i + 2 < n ? t[v & 63] : '=';
    }
    out[j] = 0;
}

/* ---------------- sockets ---------------- */
static void set_nonblock(sock_t s) {
#ifdef _WIN32
    u_long one = 1;
    ioctlsocket(s, FIONBIO, &one);
#else
    fcntl(s, F_SETFL, fcntl(s, F_GETFL, 0) | O_NONBLOCK);
#ifdef SO_NOSIGPIPE
    int one = 1;
    setsockopt(s, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof one);
#endif
#endif
    int nd = 1;
    setsockopt(s, IPPROTO_TCP, TCP_NODELAY, (const char *)&nd, sizeof nd);
}

static bool send_all(sock_t s, const void *p, size_t n) {
    const char *c = p;
    int spins = 0;
    while (n) {
#ifdef MSG_NOSIGNAL
        long r = (long)send(s, c, (int)n, MSG_NOSIGNAL);
#else
        long r = (long)send(s, c, (int)n, 0);
#endif
        if (r > 0) { c += r; n -= (size_t)r; continue; }
        if (r < 0 && WOULD_BLOCK() && spins++ < 200) {
            fd_set w; FD_ZERO(&w); FD_SET(s, &w);
            struct timeval tv = {0, 5000};
            select((int)s + 1, NULL, &w, NULL, &tv);
            continue;
        }
        return false;
    }
    return true;
}

bool server_start(unsigned short port, const ServerConfig *c) {
    cfg = *c;
    port_ = port;
#ifdef _WIN32
    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa)) return false;
#endif
    listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (listener == BAD_SOCK) return false;
#ifdef _WIN32
    /* Refuse a second helper on the same port (no SO_REUSEADDR sharing on Windows). */
    int ex = 1;
    setsockopt(listener, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, (const char *)&ex, sizeof ex);
#else
    int ra = 1;
    setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &ra, sizeof ra);
#endif
    struct sockaddr_in a;
    memset(&a, 0, sizeof a);
    a.sin_family = AF_INET;
    a.sin_port = htons(port);
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (bind(listener, (struct sockaddr *)&a, sizeof a) != 0 || listen(listener, 8) != 0) {
        sock_close(listener);
        listener = BAD_SOCK;
        return false;
    }
    set_nonblock(listener);
    return true;
}

static void drop(int i) {
    Client *c = clients[i];
    if (!c) return;
    int kind = c->kind;
    sock_close(c->s);
    free(c);
    clients[i] = NULL;
    if (kind && cfg.on_close) cfg.on_close(i, kind);
}

void server_close_client(int cid) {
    if (cid < 0 || cid >= MAX_CLIENTS || !clients[cid]) return;
    unsigned char fr[4] = {0x88, 2, 0x03, 0xE8}; /* close 1000 */
    send_all(clients[cid]->s, fr, sizeof fr);
    drop(cid);
}

void server_stop(void) {
    for (int i = 0; i < MAX_CLIENTS; i++) if (clients[i]) server_close_client(i);
    if (listener != BAD_SOCK) sock_close(listener);
    listener = BAD_SOCK;
#ifdef _WIN32
    WSACleanup();
#endif
}

/* Header value (case-insensitive name), copied into out. */
static bool header(const char *req, const char *name, char *out, size_t cap) {
    size_t nl = strlen(name);
    for (const char *p = strstr(req, "\r\n"); p; p = strstr(p + 2, "\r\n")) {
        const char *l = p + 2;
        if (!*l || (l[0] == '\r' && l[1] == '\n')) break;
        bool match = true;
        for (size_t i = 0; i < nl && match; i++) match = tolower((unsigned char)l[i]) == tolower((unsigned char)name[i]);
        if (!match || l[nl] != ':') continue;
        l += nl + 1;
        while (*l == ' ' || *l == '\t') l++;
        size_t j = 0;
        while (*l && *l != '\r' && j + 1 < cap) out[j++] = *l++;
        out[j] = 0;
        return true;
    }
    return false;
}

static bool own_host(const char *host) {
    char a[64], b[64];
    snprintf(a, sizeof a, "127.0.0.1:%u", port_);
    snprintf(b, sizeof b, "localhost:%u", port_);
    return !strcmp(host, a) || !strcmp(host, b);
}

static void http_reply_ex(Client *c, const char *status, const char *type, const char *body, size_t n, const char *attachment) {
    char h[768], disp[160] = "";
    if (attachment && *attachment) snprintf(disp, sizeof disp, "Content-Disposition: attachment; filename=\"%s\"\r\n", attachment);
    int hl = snprintf(h, sizeof h,
        "HTTP/1.1 %s\r\nContent-Type: %s\r\nContent-Length: %u\r\nCache-Control: no-store\r\n%s"
        "X-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\n"
        "Content-Security-Policy: default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:%u ws://localhost:%u\r\n"
        "Connection: close\r\n\r\n", status, type, (unsigned)n, disp, port_, port_);
    send_all(c->s, h, (size_t)hl);
    if (n) send_all(c->s, body, n);
}
static void http_reply(Client *c, const char *status, const char *type, const char *body, size_t n) {
    http_reply_ex(c, status, type, body, n, NULL);
}

/* Returns false when the client must be dropped. */
static bool handle_http(int i) {
    Client *c = clients[i];
    c->buf[c->len < BUF_CAP ? c->len : BUF_CAP - 1] = 0;
    char *end = strstr((char *)c->buf, "\r\n\r\n");
    if (!end) return c->len < BUF_CAP - 1;
    char *req = (char *)c->buf;
    char method[8] = "", path[256] = "";
    sscanf(req, "%7s %255s", method, path);
    char host[128] = "", origin[256] = "", upgrade[32] = "", key[64] = "";
    header(req, "Host", host, sizeof host);
    bool has_origin = header(req, "Origin", origin, sizeof origin);
    header(req, "Upgrade", upgrade, sizeof upgrade);
    header(req, "Sec-WebSocket-Key", key, sizeof key);

    if (strcmp(method, "GET") != 0) { http_reply(c, "405 Method Not Allowed", "text/plain", "", 0); return false; }
    bool ws = upgrade[0] && (upgrade[0] == 'w' || upgrade[0] == 'W') && key[0];
    if (!ws) {
        if (!own_host(host)) { http_reply(c, "403 Forbidden", "text/plain", "forbidden", 9); return false; }
        HttpBody b;
        memset(&b, 0, sizeof b);
        if (!strcmp(path, "/") || !strncmp(path, "/?", 2)) http_reply(c, "200 OK", "text/html; charset=utf-8", cfg.page, cfg.page_len);
        else if (cfg.http_get && cfg.http_get(path, &b)) {
            http_reply_ex(c, "200 OK", b.type, b.body, b.len, b.filename);
            free(b.body);
        } else http_reply(c, "404 Not Found", "text/plain", "not found", 9);
        return false;
    }
    int kind = 0;
    if (!strcmp(path, "/ws/ui")) {
        char own1[64], own2[64];
        snprintf(own1, sizeof own1, "http://127.0.0.1:%u", port_);
        snprintf(own2, sizeof own2, "http://localhost:%u", port_);
        if (own_host(host) && has_origin && (!strcmp(origin, own1) || !strcmp(origin, own2))) kind = CLIENT_UI;
    } else if (!strcmp(path, "/ws/game")) {
        if (has_origin && cfg.allow_game_origin && cfg.allow_game_origin(origin)) kind = CLIENT_GAME;
    }
    if (!kind) {
        SDL_Log("refused %s from origin '%s'", path, origin);
        http_reply(c, "403 Forbidden", "text/plain", "origin not allowed", 18);
        return false;
    }
    char cat[128], acc[32];
    unsigned char dig[20];
    snprintf(cat, sizeof cat, "%s258EAFA5-E914-47DA-95CA-C5AB0DC85B11", key);
    sha1((const unsigned char *)cat, strlen(cat), dig);
    base64(dig, 20, acc);
    char h[256];
    int hl = snprintf(h, sizeof h, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n", acc);
    if (!send_all(c->s, h, (size_t)hl)) return false;
    size_t used = (size_t)(end + 4 - req);
    memmove(c->buf, c->buf + used, c->len - used);
    c->len -= used;
    c->kind = kind;
    if (cfg.on_open) cfg.on_open(i, kind, origin);
    return true;
}

static bool send_frame(sock_t s, int opcode, const void *p, size_t n) {
    unsigned char h[10];
    size_t hl;
    h[0] = (unsigned char)(0x80 | opcode);
    if (n < 126) { h[1] = (unsigned char)n; hl = 2; }
    else if (n < 65536) { h[1] = 126; h[2] = (unsigned char)(n >> 8); h[3] = (unsigned char)n; hl = 4; }
    else { h[1] = 127; for (int k = 0; k < 8; k++) h[2 + k] = (unsigned char)((uint64_t)n >> (56 - 8 * k)); hl = 10; }
    return send_all(s, h, hl) && (!n || send_all(s, p, n));
}

bool server_send(int cid, const char *text, size_t len) {
    if (cid < 0 || cid >= MAX_CLIENTS || !clients[cid] || !clients[cid]->kind) return false;
    if (!send_frame(clients[cid]->s, 1, text, len)) { drop(cid); return false; }
    return true;
}

/* Parses complete frames; false = drop. */
static bool handle_ws(int i) {
    for (;;) {
        Client *c = clients[i];
        if (!c) return true;
        if (c->len < 2) return true;
        unsigned char *b = c->buf;
        bool fin = b[0] & 0x80, masked = b[1] & 0x80;
        int op = b[0] & 0x0F;
        uint64_t n = b[1] & 0x7F;
        size_t hl = 2;
        if (n == 126) { if (c->len < 4) return true; n = (uint64_t)b[2] << 8 | b[3]; hl = 4; }
        else if (n == 127) { if (c->len < 10) return true; n = 0; for (int k = 0; k < 8; k++) n = n << 8 | b[2 + k]; hl = 10; }
        if (!masked || !fin || n > BUF_CAP - 32) return false; /* clients must mask; no fragments */
        if (c->len < hl + 4 + n) return true;
        unsigned char *m = b + hl, *p = b + hl + 4;
        for (uint64_t k = 0; k < n; k++) p[k] ^= m[k & 3];
        size_t total = hl + 4 + (size_t)n;
        if (op == 8) { send_frame(c->s, 8, p, n >= 2 ? 2 : 0); return false; }
        if (op == 9) send_frame(c->s, 10, p, (size_t)n);
        else if (op == 1) {
            char saved = (char)p[n];
            p[n] = 0;
            if (cfg.on_text) cfg.on_text(i, (char *)p, (size_t)n);
            if (!clients[i]) return true; /* closed from the callback */
            p[n] = (unsigned char)saved;
        }
        memmove(c->buf, c->buf + total, c->len - total);
        c->len -= total;
    }
}

void server_poll(int timeout_ms) {
    if (listener == BAD_SOCK) return;
    fd_set r;
    FD_ZERO(&r);
    FD_SET(listener, &r);
    sock_t maxs = listener;
    for (int i = 0; i < MAX_CLIENTS; i++) if (clients[i]) { FD_SET(clients[i]->s, &r); if (clients[i]->s > maxs) maxs = clients[i]->s; }
    struct timeval tv = {timeout_ms / 1000, (timeout_ms % 1000) * 1000};
    if (select((int)maxs + 1, &r, NULL, NULL, &tv) <= 0) return;
    if (FD_ISSET(listener, &r)) {
        sock_t s = accept(listener, NULL, NULL);
        if (s != BAD_SOCK) {
            int slot = -1;
            for (int i = 0; i < MAX_CLIENTS && slot < 0; i++) if (!clients[i]) slot = i;
            Client *c = slot >= 0 ? calloc(1, sizeof *c) : NULL;
            if (!c) sock_close(s);
            else { set_nonblock(s); c->s = s; clients[slot] = c; }
        }
    }
    for (int i = 0; i < MAX_CLIENTS; i++) {
        Client *c = clients[i];
        if (!c || !FD_ISSET(c->s, &r)) continue;
        long n = (long)recv(c->s, (char *)c->buf + c->len, (int)(BUF_CAP - 1 - c->len), 0);
        if (n <= 0) { if (n < 0 && WOULD_BLOCK()) continue; drop(i); continue; }
        c->len += (size_t)n;
        bool ok;
        if (c->kind) ok = handle_ws(i);
        else ok = handle_http(i) && (!clients[i] || !clients[i]->kind || handle_ws(i)); /* frames sent with the handshake */
        if (!ok && clients[i]) drop(i);
    }
}
