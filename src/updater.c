/* Self-update from GitHub Releases: see updater.h. */
#include "updater.h"
#include <SDL3/SDL.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>

#ifdef _WIN32
#include <windows.h>
#include <winhttp.h>
#define ASSET "ArcadeFFBHelper.exe"
#define CAN_UPDATE 1
#elif defined(__APPLE__)
#include <spawn.h>
#include <sys/wait.h>
#include <unistd.h>
extern char **environ;
#if defined(__arm64__) || defined(__aarch64__)
#define ASSET "Arcade-FFB-Helper-mac-arm64.zip"
#define CAN_UPDATE 1
#endif
#endif
#ifndef CAN_UPDATE
#define CAN_UPDATE 0
#define ASSET ""
#endif

#define REPO "johannruiz/arcade-ffb-helper"
#define API_URL "https://api.github.com/repos/" REPO "/releases/latest"
#define DOWNLOAD_PREFIX "https://github.com/" REPO "/releases/download/"
#define MAX_API (1u << 20)
#define MAX_DOWNLOAD (64u << 20)
#define CHECK_EVERY_MS (24ull * 3600 * 1000)
#define RETRY_EVERY_MS (6ull * 3600 * 1000)

static SDL_Mutex *mu;
static SDL_AtomicInt enabled_flag;
static UpdState state = UPD_WAITING;
static char cur[32], latest_tag[32], message[256], installed[32], staged_tag[32], ua[64];

/* ---------------- state ---------------- */
static void set_state(UpdState s, const char *fmt, ...) {
    char m[256] = "";
    if (fmt) {
        va_list ap;
        va_start(ap, fmt);
        vsnprintf(m, sizeof m, fmt, ap);
        va_end(ap);
    }
    SDL_LockMutex(mu);
    bool changed = s != state || strcmp(m, message);
    state = s;
    SDL_strlcpy(message, m, sizeof message);
    SDL_UnlockMutex(mu);
    if (changed && m[0]) SDL_Log("update: %s", m);
}
static UpdState get_state(void) {
    SDL_LockMutex(mu);
    UpdState s = state;
    SDL_UnlockMutex(mu);
    return s;
}

UpdState updater_status(char *latest, size_t lcap, char *msg, size_t mcap) {
    if (!mu) { if (lcap) latest[0] = 0; if (mcap) msg[0] = 0; return UPD_OFF; }
    SDL_LockMutex(mu);
    UpdState s = state;
    if (lcap) SDL_strlcpy(latest, latest_tag, lcap);
    if (mcap) SDL_strlcpy(msg, message, mcap);
    SDL_UnlockMutex(mu);
    return s;
}

const char *updater_state_name(UpdState s) {
    static const char *n[] = {"off", "waiting", "checking", "latest", "downloading", "ready", "failed"};
    return (unsigned)s < sizeof n / sizeof n[0] ? n[s] : "?";
}

void updater_enable(bool on) { SDL_SetAtomicInt(&enabled_flag, on && CAN_UPDATE ? 1 : 0); }

/* ---------------- small helpers ---------------- */
typedef struct { unsigned char *p; size_t len, cap; } Buf;
static bool buf_add(Buf *b, const void *d, size_t n, size_t max) {
    if (b->len + n + 1 > max) return false;
    if (b->len + n + 1 > b->cap) {
        size_t cap = b->cap ? b->cap : 65536;
        while (cap < b->len + n + 1) cap *= 2;
        unsigned char *q = realloc(b->p, cap);
        if (!q) return false;
        b->p = q; b->cap = cap;
    }
    memcpy(b->p + b->len, d, n);
    b->len += n;
    b->p[b->len] = 0;
    return true;
}

static bool parse_version(const char *s, int v[3]) {
    if (*s == 'v' || *s == 'V') s++;
    return sscanf(s, "%d.%d.%d", &v[0], &v[1], &v[2]) == 3;
}
static int compare_versions(const char *a, const char *b) {
    int x[3], y[3];
    if (!parse_version(a, x) || !parse_version(b, y)) return 0;
    for (int i = 0; i < 3; i++) if (x[i] != y[i]) return x[i] < y[i] ? -1 : 1;
    return 0;
}

static const char *find(const char *from, const char *end, const char *needle) {
    size_t n = strlen(needle);
    for (const char *p = from; p + n <= end; p++) if (*p == *needle && !memcmp(p, needle, n)) return p;
    return NULL;
}
/* The string value of the first "key" in [from, end), JSON escapes reduced to the escaped char.
 * Returns the position after the value, or NULL. */
static const char *json_string(const char *from, const char *end, const char *key, char *out, size_t cap) {
    char k[64];
    snprintf(k, sizeof k, "\"%s\"", key);
    for (const char *p = from; (p = find(p, end, k)); p += strlen(k)) {
        const char *q = p + strlen(k);
        while (q < end && (*q == ' ' || *q == '\t' || *q == '\r' || *q == '\n')) q++;
        if (q >= end || *q != ':') continue;
        q++;
        while (q < end && (*q == ' ' || *q == '\t' || *q == '\r' || *q == '\n')) q++;
        if (q >= end || *q != '"') continue;
        q++;
        size_t j = 0;
        while (q < end && *q != '"') {
            if (*q == '\\' && q + 1 < end) q++;
            if (j + 1 < cap) out[j++] = *q;
            q++;
        }
        if (q >= end) return NULL;
        out[j] = 0;
        return q + 1;
    }
    return NULL;
}

/* ---------------- SHA-256 ---------------- */
static const Uint32 K256[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
};
#define ROR(x, n) (((x) >> (n)) | ((x) << (32 - (n))))
static void sha256_block(Uint32 h[8], const unsigned char *p) {
    Uint32 w[64];
    for (int i = 0; i < 16; i++) w[i] = (Uint32)p[i * 4] << 24 | (Uint32)p[i * 4 + 1] << 16 | (Uint32)p[i * 4 + 2] << 8 | p[i * 4 + 3];
    for (int i = 16; i < 64; i++) {
        Uint32 s0 = ROR(w[i - 15], 7) ^ ROR(w[i - 15], 18) ^ (w[i - 15] >> 3);
        Uint32 s1 = ROR(w[i - 2], 17) ^ ROR(w[i - 2], 19) ^ (w[i - 2] >> 10);
        w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    Uint32 a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], k = h[7];
    for (int i = 0; i < 64; i++) {
        Uint32 t1 = k + (ROR(e, 6) ^ ROR(e, 11) ^ ROR(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i];
        Uint32 t2 = (ROR(a, 2) ^ ROR(a, 13) ^ ROR(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
        k = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += k;
}
static void sha256_hex(const unsigned char *d, size_t n, char out[65]) {
    Uint32 h[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
    size_t i = 0;
    for (; i + 64 <= n; i += 64) sha256_block(h, d + i);
    unsigned char last[128] = {0};
    size_t r = n - i;
    memcpy(last, d + i, r);
    last[r] = 0x80;
    size_t total = r + 1 + 8 <= 64 ? 64 : 128;
    Uint64 bits = (Uint64)n * 8;
    for (int j = 0; j < 8; j++) last[total - 1 - j] = (unsigned char)(bits >> (8 * j));
    sha256_block(h, last);
    if (total == 128) sha256_block(h, last + 64);
    for (int j = 0; j < 8; j++) snprintf(out + j * 8, 9, "%08x", (unsigned)h[j]);
}

/* ---------------- platform: paths, download, swap, start ---------------- */
#ifdef _WIN32
static wchar_t exe_w[MAX_PATH * 2], new_w[MAX_PATH * 2 + 8], part_w[MAX_PATH * 2 + 8], old_w[MAX_PATH * 2 + 8], dir_w[MAX_PATH * 2];

static bool paths_init(void) {
    DWORD n = GetModuleFileNameW(NULL, exe_w, MAX_PATH * 2);
    if (!n || n >= MAX_PATH * 2) return false;
    _snwprintf(new_w, MAX_PATH * 2 + 8, L"%ls.new", exe_w);
    _snwprintf(part_w, MAX_PATH * 2 + 8, L"%ls.part", exe_w);
    _snwprintf(old_w, MAX_PATH * 2 + 8, L"%ls.old", exe_w);
    wcscpy(dir_w, exe_w);
    wchar_t *slash = wcsrchr(dir_w, L'\\');
    if (slash) *slash = 0;
    return true;
}

static bool fetch(const char *url, bool api, Buf *b, size_t max, char *err, size_t ecap) {
    wchar_t wurl[2048], host[256], path[2048];
    MultiByteToWideChar(CP_UTF8, 0, url, -1, wurl, 2048);
    URL_COMPONENTS uc;
    memset(&uc, 0, sizeof uc);
    uc.dwStructSize = sizeof uc;
    uc.lpszHostName = host; uc.dwHostNameLength = 256;
    uc.lpszUrlPath = path; uc.dwUrlPathLength = 2048;
    if (!WinHttpCrackUrl(wurl, 0, 0, &uc) || uc.nScheme != INTERNET_SCHEME_HTTPS) { snprintf(err, ecap, "bad address"); return false; }
    wchar_t uaw[64];
    MultiByteToWideChar(CP_UTF8, 0, ua, -1, uaw, 64);
    HINTERNET s = WinHttpOpen(uaw, WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!s) s = WinHttpOpen(uaw, WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    HINTERNET c = s ? WinHttpConnect(s, host, uc.nPort, 0) : NULL;
    HINTERNET r = c ? WinHttpOpenRequest(c, L"GET", path, NULL, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, WINHTTP_FLAG_SECURE) : NULL;
    bool ok = false;
    DWORD status = 0, sz = sizeof status;
    if (r) {
        WinHttpSetTimeouts(s, 15000, 15000, 20000, 60000);
        const wchar_t *hdr = api ? L"Accept: application/vnd.github+json\r\nX-GitHub-Api-Version: 2022-11-28\r\n" : WINHTTP_NO_ADDITIONAL_HEADERS;
        if (WinHttpSendRequest(r, hdr, api ? (DWORD)-1L : 0, WINHTTP_NO_REQUEST_DATA, 0, 0, 0) && WinHttpReceiveResponse(r, NULL) &&
            WinHttpQueryHeaders(r, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_HEADER_NAME_BY_INDEX, &status, &sz, WINHTTP_NO_HEADER_INDEX)) {
            if (status == 200) {
                ok = true;
                char chunk[16384];
                for (;;) {
                    DWORD got = 0;
                    if (!WinHttpReadData(r, chunk, sizeof chunk, &got)) { ok = false; snprintf(err, ecap, "download interrupted (%lu)", GetLastError()); break; }
                    if (!got) break;
                    if (!buf_add(b, chunk, got, max)) { ok = false; snprintf(err, ecap, "file too large"); break; }
                }
            } else snprintf(err, ecap, "HTTP %lu", status);
        } else snprintf(err, ecap, "no connection (error %lu)", GetLastError());
    } else snprintf(err, ecap, "no connection (error %lu)", GetLastError());
    if (r) WinHttpCloseHandle(r);
    if (c) WinHttpCloseHandle(c);
    if (s) WinHttpCloseHandle(s);
    return ok;
}

static void cleanup_previous(void) {
    /* The previous version is the .old file; it may still be closing for a moment. */
    for (int i = 0; i < 20 && GetFileAttributesW(old_w) != INVALID_FILE_ATTRIBUTES; i++) {
        if (DeleteFileW(old_w)) { SDL_Log("update: removed the previous version's file"); break; }
        SDL_Delay(500);
    }
    DeleteFileW(new_w);
    DeleteFileW(part_w);
}

static bool stage(const Buf *f, char *err, size_t ecap) {
    if (f->len < 2 || f->p[0] != 'M' || f->p[1] != 'Z') { snprintf(err, ecap, "the download is not a Windows program"); return false; }
    FILE *o = _wfopen(part_w, L"wb");
    if (!o) { snprintf(err, ecap, "cannot write next to the helper; move ArcadeFFBHelper.exe to a folder of yours (Documents, Desktop) to get updates"); return false; }
    bool ok = fwrite(f->p, 1, f->len, o) == f->len;
    ok = fclose(o) == 0 && ok;
    if (!ok || !MoveFileExW(part_w, new_w, MOVEFILE_REPLACE_EXISTING)) {
        DeleteFileW(part_w);
        snprintf(err, ecap, "cannot save the new version next to the helper");
        return false;
    }
    return true;
}

static bool swap_in(char *err, size_t ecap) {
    DeleteFileW(old_w);
    if (!MoveFileExW(exe_w, old_w, MOVEFILE_REPLACE_EXISTING)) { snprintf(err, ecap, "cannot move the running helper aside (error %lu)", GetLastError()); return false; }
    if (!MoveFileExW(new_w, exe_w, MOVEFILE_REPLACE_EXISTING)) {
        snprintf(err, ecap, "cannot put the new version in place (error %lu)", GetLastError());
        MoveFileExW(old_w, exe_w, MOVEFILE_REPLACE_EXISTING);
        return false;
    }
    return true;
}
static void swap_back(void) {
    MoveFileExW(exe_w, new_w, MOVEFILE_REPLACE_EXISTING);
    MoveFileExW(old_w, exe_w, MOVEFILE_REPLACE_EXISTING);
}

static bool start_program(const char *tag) {
    wchar_t cmd[MAX_PATH * 2 + 96], wtag[32] = L"";
    if (tag) MultiByteToWideChar(CP_UTF8, 0, tag, -1, wtag, 32);
    _snwprintf(cmd, sizeof cmd / sizeof cmd[0], tag ? L"\"%ls\" --background --updated %ls" : L"\"%ls\" --background", exe_w, wtag);
    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    memset(&si, 0, sizeof si);
    si.cb = sizeof si;
    if (!CreateProcessW(exe_w, cmd, NULL, NULL, FALSE, 0, NULL, dir_w, &si, &pi)) return false;
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return true;
}

#elif CAN_UPDATE /* macOS */
static char bundle[1024], parent[1024], upd_dir[1100], zip_path[1200], new_dir[1200], new_app[1300], prev_app[1300];

static int run(const char *const argv[]) {
    pid_t pid;
    if (posix_spawn(&pid, argv[0], NULL, NULL, (char *const *)argv, environ) != 0) return -1;
    int st = 0;
    if (waitpid(pid, &st, 0) < 0) return -1;
    return WIFEXITED(st) ? WEXITSTATUS(st) : -1;
}
static void remove_tree(const char *p) {
    const char *argv[] = {"/bin/rm", "-rf", p, NULL};
    run(argv);
}

static bool paths_init(const char *work) {
    const char *base = SDL_GetBasePath(); /* .../Arcade FFB Helper.app/Contents/Resources/ */
    const char *app = base ? strstr(base, ".app/Contents/") : NULL;
    if (!app) return false; /* not running from an app bundle (a development build) */
    size_t n = (size_t)(app - base) + 4;
    if (n >= sizeof bundle) return false;
    memcpy(bundle, base, n);
    bundle[n] = 0;
    SDL_strlcpy(parent, bundle, sizeof parent);
    char *slash = strrchr(parent, '/');
    if (!slash) return false;
    *slash = 0;
    snprintf(upd_dir, sizeof upd_dir, "%supdate", work);
    snprintf(zip_path, sizeof zip_path, "%s/download.zip", upd_dir);
    snprintf(new_dir, sizeof new_dir, "%s/new", upd_dir);
    snprintf(new_app, sizeof new_app, "%s/Arcade FFB Helper.app", new_dir);
    snprintf(prev_app, sizeof prev_app, "%s/previous.app", upd_dir);
    return true;
}

static bool fetch(const char *url, bool api, Buf *b, size_t max, char *err, size_t ecap) {
    SDL_CreateDirectory(upd_dir);
    char out[1200], maxs[32];
    snprintf(out, sizeof out, "%s/fetch.tmp", upd_dir);
    snprintf(maxs, sizeof maxs, "%zu", max);
    remove(out);
    const char *argv[] = {"/usr/bin/curl", "-fsSL", "--proto", "=https", "--proto-redir", "=https", "--max-time", "300",
                          "--max-filesize", maxs, "-A", ua, "-H", api ? "Accept: application/vnd.github+json" : "Accept: */*",
                          "-o", out, url, NULL};
    int rc = run(argv);
    if (rc != 0) { snprintf(err, ecap, "download failed (curl %d)", rc); remove(out); return false; }
    FILE *f = fopen(out, "rb");
    if (!f) { snprintf(err, ecap, "download failed"); return false; }
    char chunk[16384];
    size_t got;
    bool ok = true;
    while ((got = fread(chunk, 1, sizeof chunk, f)) > 0) if (!buf_add(b, chunk, got, max)) { ok = false; snprintf(err, ecap, "file too large"); break; }
    fclose(f);
    remove(out);
    return ok;
}

static void cleanup_previous(void) {
    if (SDL_GetPathInfo(upd_dir, NULL)) { remove_tree(upd_dir); SDL_Log("update: removed the previous version's files"); }
}

static bool stage(const Buf *f, char *err, size_t ecap) {
    if (strstr(bundle, "/AppTranslocation/") || access(parent, W_OK) != 0) {
        snprintf(err, ecap, "the app cannot replace itself where it is; move it to Applications to get updates");
        return false;
    }
    if (f->len < 2 || f->p[0] != 'P' || f->p[1] != 'K') { snprintf(err, ecap, "the download is not a zip"); return false; }
    SDL_CreateDirectory(upd_dir);
    FILE *o = fopen(zip_path, "wb");
    if (!o) { snprintf(err, ecap, "cannot save the download"); return false; }
    bool ok = fwrite(f->p, 1, f->len, o) == f->len;
    ok = fclose(o) == 0 && ok;
    remove_tree(new_dir);
    const char *argv[] = {"/usr/bin/ditto", "-x", "-k", zip_path, new_dir, NULL};
    char bin[1400];
    snprintf(bin, sizeof bin, "%s/Contents/MacOS/Arcade FFB Helper", new_app);
    if (!ok || run(argv) != 0 || access(bin, X_OK) != 0) { snprintf(err, ecap, "cannot unpack the new version"); return false; }
    remove(zip_path);
    return true;
}

static bool swap_in(char *err, size_t ecap) {
    remove_tree(prev_app);
    if (rename(bundle, prev_app) != 0) { snprintf(err, ecap, "cannot move the running app aside"); return false; }
    if (rename(new_app, bundle) != 0) {
        snprintf(err, ecap, "cannot put the new version in place");
        rename(prev_app, bundle);
        return false;
    }
    return true;
}
static void swap_back(void) {
    rename(bundle, new_app);
    rename(prev_app, bundle);
}

static bool start_program(const char *tag) {
    const char *argv[] = {"/usr/bin/open", "-n", bundle, "--args", "--background", tag ? "--updated" : NULL, tag, NULL};
    return run(argv) == 0;
}
#endif

/* ---------------- the check ---------------- */
static void check_once(void) {
#if CAN_UPDATE
    set_state(UPD_CHECKING, NULL);
    char err[256] = "";
    Buf api = {0};
    if (!fetch(API_URL, true, &api, MAX_API, err, sizeof err)) {
        free(api.p);
        set_state(UPD_FAILED, "could not ask GitHub for the latest version: %s", err);
        return;
    }
    const char *js = (const char *)api.p, *end = js + api.len;
    char tag[32] = "", url[512] = "", digest[100] = "";
    bool asset = false;
    if (json_string(js, end, "tag_name", tag, sizeof tag)) {
        /* this platform's file: its download address and the SHA-256 GitHub computed for it */
        char name[160];
        for (const char *p = js, *after; (p = find(p, end, "\"name\"")); p = after) {
            after = json_string(p, end, "name", name, sizeof name);
            if (!after) break;
            if (strcmp(name, ASSET)) continue;
            const char *u = find(after, end, "\"browser_download_url\"");
            const char *uend = u ? json_string(u, end, "browser_download_url", url, sizeof url) : NULL;
            asset = uend && json_string(after, uend, "digest", digest, sizeof digest);
            break;
        }
    }
    free(api.p);
    int v[3];
    if (!parse_version(tag, v)) { set_state(UPD_FAILED, "GitHub's answer has no version"); return; }
    SDL_LockMutex(mu);
    SDL_strlcpy(latest_tag, tag, sizeof latest_tag);
    SDL_UnlockMutex(mu);
    if (compare_versions(tag, cur) <= 0) { set_state(UPD_LATEST, "%s is the latest version", cur); return; }
    if (installed[0] && !strcmp(installed, tag)) {
        /* started as this release, yet older than it says: never loop on it */
        set_state(UPD_FAILED, "release %s holds an older version (%s); not installing it again", tag, cur);
        return;
    }
    char expect[300];
    snprintf(expect, sizeof expect, DOWNLOAD_PREFIX "%s/" ASSET, tag);
    if (!asset || strcmp(url, expect) || strncmp(digest, "sha256:", 7) || strlen(digest) != 7 + 64) {
        set_state(UPD_FAILED, "release %s has no verifiable " ASSET " yet", tag);
        return;
    }
    set_state(UPD_DOWNLOADING, "downloading %s", tag);
    Buf f = {0};
    if (!fetch(url, false, &f, MAX_DOWNLOAD, err, sizeof err)) {
        free(f.p);
        set_state(UPD_FAILED, "could not download %s: %s", tag, err);
        return;
    }
    char hex[65];
    sha256_hex(f.p, f.len, hex);
    if (SDL_strcasecmp(hex, digest + 7)) {
        free(f.p);
        set_state(UPD_FAILED, "the download of %s does not match GitHub's SHA-256; discarded", tag);
        return;
    }
    bool ok = stage(&f, err, sizeof err);
    size_t size = f.len;
    free(f.p);
    if (!ok) { set_state(UPD_FAILED, "%s: %s", tag, err); return; }
    SDL_LockMutex(mu);
    SDL_strlcpy(staged_tag, tag, sizeof staged_tag);
    SDL_UnlockMutex(mu);
    set_state(UPD_READY, "%s downloaded (%zu bytes, SHA-256 checked); it installs when no race is running", tag, size);
#endif
}

static int SDLCALL thread_main(void *u) {
    (void)u;
    SDL_Delay(3000); /* a just-updated predecessor has this long to close */
#if CAN_UPDATE
    cleanup_previous();
#endif
    Uint64 next = 0;
    bool was_on = false;
    for (;;) {
        bool on = SDL_GetAtomicInt(&enabled_flag) != 0;
        if (on && !was_on) next = 0; /* turned on: check now */
        if (!on && was_on) set_state(UPD_OFF, NULL);
        was_on = on;
        if (on && SDL_GetTicks() >= next) {
            check_once();
            if (get_state() == UPD_READY) return 0; /* the main loop takes it from here */
            next = SDL_GetTicks() + (get_state() == UPD_FAILED ? RETRY_EVERY_MS : CHECK_EVERY_MS);
        }
        SDL_Delay(1000);
    }
}

void updater_start(const char *current, const char *work_dir, const char *installed_tag, bool enabled) {
    mu = SDL_CreateMutex();
    SDL_strlcpy(cur, current, sizeof cur);
    SDL_strlcpy(installed, installed_tag ? installed_tag : "", sizeof installed);
    snprintf(ua, sizeof ua, "ArcadeFFBHelper/%s", current);
    updater_enable(enabled);
#if CAN_UPDATE
#ifdef _WIN32
    bool ok = paths_init();
#else
    bool ok = paths_init(work_dir);
#endif
    if (!ok) { set_state(UPD_OFF, "this copy cannot update itself (not a release build)"); SDL_SetAtomicInt(&enabled_flag, 0); return; }
    if (!enabled) set_state(UPD_OFF, NULL);
    SDL_Thread *t = SDL_CreateThread(thread_main, "updater", NULL);
    if (t) SDL_DetachThread(t);
#else
    (void)work_dir;
    set_state(UPD_OFF, NULL);
#endif
}

bool updater_install(void) {
#if CAN_UPDATE
    if (get_state() != UPD_READY) return false;
    char err[256] = "";
    if (!swap_in(err, sizeof err)) { set_state(UPD_FAILED, "%s", err); return false; }
    SDL_Log("update: %s is in place; restarting", staged_tag);
    return true;
#else
    return false;
#endif
}

bool updater_relaunch(void) {
#if CAN_UPDATE
    if (start_program(staged_tag)) return true;
    SDL_Log("update: the new version did not start; going back to %s", cur);
    swap_back();
    return start_program(NULL);
#else
    return false;
#endif
}
