/* Minimal HTTP + WebSocket server on 127.0.0.1 (single thread, select-based). */
#pragma once
#include <stdbool.h>
#include <stddef.h>

enum { CLIENT_GAME = 1, CLIENT_UI = 2 };

/* A generated GET response; body is malloc'd and freed by the server. */
typedef struct {
    const char *type;
    char *body;
    size_t len;
    char filename[96];   /* non-empty: sent as an attachment with this name */
} HttpBody;

typedef struct {
    /* An origin allowed on /ws/game (the games' pages). */
    bool (*allow_game_origin)(const char *origin);
    void (*on_open)(int cid, int kind, const char *origin);
    void (*on_text)(int cid, char *msg, size_t len); /* msg is NUL-terminated, may be modified */
    void (*on_close)(int cid, int kind);
    /* Served at "/" */
    const char *page;
    size_t page_len;
    /* Other GET paths on this server's own host (e.g. /report); false = 404. */
    bool (*http_get)(const char *path, HttpBody *out);
} ServerConfig;

/* false when the port cannot be bound (usually: the helper is already running). */
bool server_start(unsigned short port, const ServerConfig *cfg);
/* Accepts and reads; waits at most timeout_ms for activity. */
void server_poll(int timeout_ms);
bool server_send(int cid, const char *text, size_t len);
void server_close_client(int cid);
void server_stop(void);
