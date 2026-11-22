/*
 * Arcade FFB Helper: drives a wheel's force feedback for the arcade web ports played in the
 * user's own browser.
 *
 * The game page (with window.arcadeForceFeedback) connects to ws://127.0.0.1:47823/ws/game and
 * sends the drive board's forces; the helper shapes them with the user's settings and plays
 * them on the wheel through SDL3. Its settings page is http://127.0.0.1:47823/ (tray icon).
 *
 * Game page -> helper (text frames):
 *   hello <game> <api_version>                         game: d1 | d2 | scud
 *   f <live 0|1> <constant> <spring> <damper> <friction> <rumble>
 *        constant -1..1 (+ = right), the others 0..1; at most every 8 ms, at least every 250 ms
 * Helper -> game page:
 *   hi <helper_version> <wheel 0|1> <device name>      after hello and when the wheel changes
 *
 * Settings page <-> helper:
 *   <- state {json}  (20 Hz)
 *   -> set <key> <value> | device <name or empty = automatic> | test <left|right|spring|damper|rumble|stop>
 *      | refresh | reset
 */
#include <SDL3/SDL.h>
#include <SDL3/SDL_main.h>
#include <stdio.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include "ffb_device.h"
#include "server.h"
#include "ui_page.h"

#ifdef _WIN32
#include <windows.h>
#elif defined(__APPLE__)
#include <sys/sysctl.h>
#endif

#ifndef HELPER_VERSION
#define HELPER_VERSION "0.0.0-dev" /* set by CMake from project(VERSION) */
#endif
#define PORT 47823
#define MAX_CLIENTS 16

static float clampf(float v, float lo, float hi) { return !(v == v) ? 0 : v < lo ? lo : (v > hi ? hi : v); }

/* ---------------- settings ---------------- */
typedef struct {
    bool enabled;
    float strength, constantGain, springGain, damperGain, frictionGain, rumbleGain;
    float minSpring, minForce, smoothing;
    int deviceGain;
    bool invert_d1, invert_d2, invert_scud;
    bool openOnStart;
    char device[128];   /* empty = automatic */
    char origins[512];  /* extra allowed game origins, comma separated */
} Settings;

static Settings S;
static const Settings DEFAULTS = {
    true, 0.8f, 1.0f, 1.0f, 1.0f, 1.0f, 0.35f,
    0.08f, 0.05f, 0.25f,
    100,
    false, false, false,
    true, "", "",
};

typedef enum { T_BOOL, T_FLOAT, T_INT } FieldType;
static const struct { const char *key; FieldType t; size_t off; float lo, hi; } FIELDS[] = {
    {"enabled", T_BOOL, offsetof(Settings, enabled), 0, 1},
    {"strength", T_FLOAT, offsetof(Settings, strength), 0, 1.5f},
    {"constantGain", T_FLOAT, offsetof(Settings, constantGain), 0, 2},
    {"springGain", T_FLOAT, offsetof(Settings, springGain), 0, 2},
    {"damperGain", T_FLOAT, offsetof(Settings, damperGain), 0, 2},
    {"frictionGain", T_FLOAT, offsetof(Settings, frictionGain), 0, 2},
    {"rumbleGain", T_FLOAT, offsetof(Settings, rumbleGain), 0, 2},
    {"minSpring", T_FLOAT, offsetof(Settings, minSpring), 0, 1},
    {"minForce", T_FLOAT, offsetof(Settings, minForce), 0, 0.5f},
    {"smoothing", T_FLOAT, offsetof(Settings, smoothing), 0, 0.95f},
    {"deviceGain", T_INT, offsetof(Settings, deviceGain), 0, 100},
    {"invert_d1", T_BOOL, offsetof(Settings, invert_d1), 0, 1},
    {"invert_d2", T_BOOL, offsetof(Settings, invert_d2), 0, 1},
    {"invert_scud", T_BOOL, offsetof(Settings, invert_scud), 0, 1},
    {"openOnStart", T_BOOL, offsetof(Settings, openOnStart), 0, 1},
};
#define NFIELDS (int)(sizeof FIELDS / sizeof FIELDS[0])

static char pref_dir[1024];

/* Which way a positive constant force turns each wheel. It is not the same on every wheel:
 * SDL's convention (a direction is where the force comes from) makes a positive level push to
 * the left, as measured on a Moza and a G923 through DirectInput, but other models and drivers
 * differ (a G29 has been reported the other way). The helper measures it per wheel (calibrate:
 * a short push each way, hands off, reading the steering axis) and remembers it by name.
 *   right_sign = the level sign that turns the wheel to the right. */
#define DEFAULT_RIGHT_SIGN (-1)
typedef struct { char name[128]; int right_sign; } WheelDir;
static WheelDir wheel_dirs[16];
static int n_wheel_dirs;

static int wheel_dir_get(const char *name) {
    for (int i = 0; i < n_wheel_dirs; i++) if (!strcmp(wheel_dirs[i].name, name)) return wheel_dirs[i].right_sign;
    return 0; /* not measured */
}
static void wheel_dir_set(const char *name, int sign) {
    for (int i = 0; i < n_wheel_dirs; i++) if (!strcmp(wheel_dirs[i].name, name)) { wheel_dirs[i].right_sign = sign; return; }
    if (n_wheel_dirs < 16) { SDL_strlcpy(wheel_dirs[n_wheel_dirs].name, name, sizeof wheel_dirs[0].name); wheel_dirs[n_wheel_dirs++].right_sign = sign; }
}

static bool set_field(const char *key, const char *val) {
    for (int i = 0; i < NFIELDS; i++) {
        if (strcmp(FIELDS[i].key, key)) continue;
        void *p = (char *)&S + FIELDS[i].off;
        float v = clampf((float)atof(val), FIELDS[i].lo, FIELDS[i].hi);
        if (FIELDS[i].t == T_BOOL) *(bool *)p = !strcmp(val, "1") || !strcmp(val, "true");
        else if (FIELDS[i].t == T_INT) *(int *)p = (int)lroundf(v);
        else *(float *)p = v;
        return true;
    }
    if (!strcmp(key, "device")) { SDL_strlcpy(S.device, val, sizeof S.device); return true; }
    if (!strcmp(key, "origins")) { SDL_strlcpy(S.origins, val, sizeof S.origins); return true; }
    if (!strcmp(key, "direction")) {   /* direction=<+1|-1>|<wheel name> */
        const char *bar = strchr(val, '|');
        int sign = atoi(val);
        if (bar && bar[1] && (sign == 1 || sign == -1)) wheel_dir_set(bar + 1, sign);
        return true;
    }
    return false;
}

static void settings_path(char *out, size_t cap) { snprintf(out, cap, "%ssettings.ini", pref_dir); }

static void load_settings(void) {
    S = DEFAULTS;
    char path[1100];
    settings_path(path, sizeof path);
    FILE *f = fopen(path, "rb");
    if (!f) return;
    char line[700];
    while (fgets(line, sizeof line, f)) {
        line[strcspn(line, "\r\n")] = 0;
        char *eq = strchr(line, '=');
        if (!eq || line[0] == '#') continue;
        *eq = 0;
        set_field(line, eq + 1);
    }
    fclose(f);
}

static void save_settings(void) {
    char path[1100], tmp[1110];
    settings_path(path, sizeof path);
    snprintf(tmp, sizeof tmp, "%s.tmp", path);
    FILE *f = fopen(tmp, "wb");
    if (!f) { SDL_Log("cannot save settings: %s", tmp); return; }
    fprintf(f, "# Arcade FFB Helper " HELPER_VERSION "\n");
    for (int i = 0; i < NFIELDS; i++) {
        void *p = (char *)&S + FIELDS[i].off;
        if (FIELDS[i].t == T_BOOL) fprintf(f, "%s=%d\n", FIELDS[i].key, *(bool *)p ? 1 : 0);
        else if (FIELDS[i].t == T_INT) fprintf(f, "%s=%d\n", FIELDS[i].key, *(int *)p);
        else fprintf(f, "%s=%.3f\n", FIELDS[i].key, *(float *)p);
    }
    fprintf(f, "device=%s\norigins=%s\n", S.device, S.origins);
    for (int i = 0; i < n_wheel_dirs; i++) fprintf(f, "direction=%+d|%s\n", wheel_dirs[i].right_sign, wheel_dirs[i].name);
    fclose(f);
    SDL_RemovePath(path);
    SDL_RenamePath(tmp, path);
}

/* ---------------- logging ----------------
 * helper.log (this session) and helper-previous.log (the one before), in the settings folder,
 * plus the last LOG_LINES lines in memory for the problem report (/report). */
#define LOG_LINES 600
static FILE *log_file;
static char log_ring[LOG_LINES][240];
static int log_next, log_count;

static void clock_text(char *out, size_t cap, bool with_date) {
    SDL_Time now = 0;
    SDL_DateTime dt;
    SDL_zero(dt);
    if (SDL_GetCurrentTime(&now)) SDL_TimeToDateTime(now, &dt, true);
    if (with_date) snprintf(out, cap, "%04d-%02d-%02d %02d:%02d:%02d", dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second);
    else snprintf(out, cap, "%02d:%02d:%02d.%03d", dt.hour, dt.minute, dt.second, dt.nanosecond / 1000000);
}

static void SDLCALL log_out(void *u, int cat, SDL_LogPriority pri, const char *msg) {
    (void)u; (void)cat; (void)pri;
    char ts[32];
    clock_text(ts, sizeof ts, false);
    snprintf(log_ring[log_next], sizeof log_ring[0], "%s %s", ts, msg);
    log_next = (log_next + 1) % LOG_LINES;
    if (log_count < LOG_LINES) log_count++;
    if (log_file) { fprintf(log_file, "%s %s\n", ts, msg); fflush(log_file); }
#ifdef _WIN32
    OutputDebugStringA(msg); OutputDebugStringA("\n");
#else
    fprintf(stderr, "%s\n", msg);
#endif
}

/* ---------------- state ---------------- */
typedef struct {
    bool used;
    int kind;
    char game[16];
    char origin[128];
    Uint64 last_ms;
    bool live;
    float f[5]; /* constant spring damper friction rumble */
} Peer;

static Peer peers[MAX_CLIENTS];
static FfbDevice dev;
static float smoothed, out[5];
static float test_v[5];
static Uint64 test_until;
static int owner = -1;           /* game peer whose forces are played */
static volatile bool running = true;
static bool device_changed = true;
static FfbDeviceInfo dev_list[16];  /* refreshed on hot-plug only: listing opens every device */
static int dev_count;
static void refresh_list(void) {
    dev_count = ffb_list(&dev, dev_list, 16);
    /* Every device SDL sees, as the report needs it: name, USB ids, force feedback effects. */
    static char last[2048];
    char now[2048] = "";
    size_t j = 0;
    for (int i = 0; i < dev_count && j < sizeof now; i++) {
        char fj[256];
        ffb_features_json(dev_list[i].features, fj, sizeof fj);
        j += (size_t)snprintf(now + j, sizeof now - j, "%s%s [%04x:%04x] haptic=%d %s", i ? "; " : "", dev_list[i].name,
                              dev_list[i].vendor, dev_list[i].product, dev_list[i].haptic, fj);
    }
    if (strcmp(now, last)) { SDL_strlcpy(last, now, sizeof last); SDL_Log("devices: %s", dev_count ? now : "none"); }
}

static void os_version(char *out, size_t cap) {
#ifdef _WIN32
    typedef LONG (WINAPI *RtlGetVersionFn)(OSVERSIONINFOW *);
    OSVERSIONINFOW v;
    SDL_zero(v);
    v.dwOSVersionInfoSize = sizeof v;
    RtlGetVersionFn fn = (RtlGetVersionFn)(void *)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion");
    if (fn && fn(&v) == 0) {   /* Windows 11 still reports 10.0; its builds start at 22000 */
        bool w11 = v.dwMajorVersion == 10 && v.dwBuildNumber >= 22000;
        snprintf(out, cap, "Windows %s (%lu.%lu build %lu)", w11 ? "11" : v.dwMajorVersion == 10 ? "10" : "", v.dwMajorVersion, v.dwMinorVersion, v.dwBuildNumber);
        return;
    }
#elif defined(__APPLE__)
    char ver[32];
    size_t n = sizeof ver;
    if (sysctlbyname("kern.osproductversion", ver, &n, NULL, 0) == 0) { snprintf(out, cap, "macOS %s", ver); return; }
#endif
    snprintf(out, cap, "%s", SDL_GetPlatform());
}

static bool allow_game_origin(const char *o) {
    if (!strcmp(o, "https://johannruiz.github.io")) return true;
    if (!strncmp(o, "http://localhost:", 17) || !strcmp(o, "http://localhost")) return true;
    if (!strncmp(o, "http://127.0.0.1:", 17) || !strcmp(o, "http://127.0.0.1")) return true;
    /* extra origins from settings.ini (exact match) */
    char list[512];
    SDL_strlcpy(list, S.origins, sizeof list);
    for (char *t = strtok(list, ", "); t; t = strtok(NULL, ", ")) if (!strcmp(t, o)) return true;
    return false;
}

static int right_sign(void);
static void start_calibration(void);

static void send_hi(int cid) {
    char m[256];
    snprintf(m, sizeof m, "hi %s %d %s", HELPER_VERSION, ffb_has_wheel(&dev) ? 1 : 0, dev.joy ? dev.name : "");
    server_send(cid, m, strlen(m));
}

static void on_open(int cid, int kind, const char *origin) {
    memset(&peers[cid], 0, sizeof peers[cid]);
    peers[cid].used = true;
    peers[cid].kind = kind;
    peers[cid].last_ms = SDL_GetTicks();
    SDL_strlcpy(peers[cid].origin, origin, sizeof peers[cid].origin);
    SDL_Log("%s connected from %s", kind == CLIENT_GAME ? "game" : "settings page", origin);
}

static void on_close(int cid, int kind) {
    (void)kind;
    if (peers[cid].kind == CLIENT_GAME) SDL_Log("game %s disconnected", peers[cid].game);
    memset(&peers[cid], 0, sizeof peers[cid]);
    if (owner == cid) owner = -1;
}

static void open_wanted_device(void) {
    ffb_open(&dev, S.device);
    refresh_list();
    if (dev.joy) ffb_set_gain(&dev, S.deviceGain);
    device_changed = true;
}

static void start_test(const char *kind) {
    float s = S.strength < 0.2f ? 0.2f : S.strength;
    memset(test_v, 0, sizeof test_v);
    Uint64 len = 700;
    if (!strcmp(kind, "left")) test_v[0] = -0.6f * s;
    else if (!strcmp(kind, "right")) test_v[0] = 0.6f * s;
    else if (!strcmp(kind, "spring")) { test_v[1] = 0.8f * s; len = 3000; }
    else if (!strcmp(kind, "damper")) { test_v[2] = 0.9f * s; len = 3000; }
    else if (!strcmp(kind, "rumble")) test_v[4] = 0.7f * s;
    else len = 0;
    test_until = len ? SDL_GetTicks() + len : 0;
    if (!len) ffb_apply(&dev, 0, 0, 0, 0, 0);
    SDL_Log("test %s on %s", kind, ffb_has_wheel(&dev) ? dev.name : "no wheel");
}

static void on_text(int cid, char *msg, size_t len) {
    (void)len;
    Peer *p = &peers[cid];
    p->last_ms = SDL_GetTicks();
    if (p->kind == CLIENT_GAME) {
        if (msg[0] == 'f' && msg[1] == ' ') {
            int live = 0;
            float v[5] = {0};
            if (sscanf(msg + 2, "%d %f %f %f %f %f", &live, &v[0], &v[1], &v[2], &v[3], &v[4]) == 6) {
                p->live = live != 0;
                p->f[0] = clampf(v[0], -1, 1);
                for (int i = 1; i < 5; i++) p->f[i] = clampf(v[i], 0, 1);
                if (p->live) owner = cid;
            }
        } else if (!strncmp(msg, "hello ", 6)) {
            sscanf(msg + 6, "%15s", p->game);
            SDL_Log("game %s says hello (%s)", p->game, p->origin);
            send_hi(cid);
            if (owner < 0) owner = cid;
        }
        return;
    }
    /* settings page */
    if (!strncmp(msg, "set ", 4)) {
        char key[32] = "", val[512] = "";
        if (sscanf(msg + 4, "%31s %511[^\n]", key, val) >= 1 && set_field(key, val)) {
            if (!strcmp(key, "deviceGain")) ffb_set_gain(&dev, S.deviceGain);
            save_settings();
        }
    } else if (!strncmp(msg, "device", 6)) {
        SDL_strlcpy(S.device, msg[6] == ' ' ? msg + 7 : "", sizeof S.device);
        save_settings();
        open_wanted_device();
    } else if (!strncmp(msg, "test ", 5)) start_test(msg + 5);
    else if (!strcmp(msg, "calibrate")) start_calibration();
    else if (!strcmp(msg, "flipdir") && dev.joy) {   /* manual override of the measured direction */
        wheel_dir_set(dev.name, -right_sign());
        save_settings();
    } else if (!strcmp(msg, "refresh")) open_wanted_device();
    else if (!strcmp(msg, "reset")) {
        char keep_dev[128];
        SDL_strlcpy(keep_dev, S.device, sizeof keep_dev);
        S = DEFAULTS;
        SDL_strlcpy(S.device, keep_dev, sizeof S.device);
        ffb_set_gain(&dev, S.deviceGain);
        save_settings();
    }
}

/* ---------------- force shaping (as the launcher's adapter) ---------------- */
static bool game_invert(const char *g) {
    return (!strcmp(g, "d1") && S.invert_d1) || (!strcmp(g, "d2") && S.invert_d2) || (!strcmp(g, "scud") && S.invert_scud);
}

/* The level sign that turns the open wheel to the right (measured, or the usual one). */
static int right_sign(void) {
    int s = dev.joy ? wheel_dir_get(dev.name) : 0;
    return s ? s : DEFAULT_RIGHT_SIGN;
}

/* Everything in `out` is in the games' convention (+ = to the right); only here is the
 * constant force turned into the wheel's own sign. */
static void play(const float v[5]) {
    ffb_apply(&dev, v[0] * (float)right_sign(), v[1], v[2], v[3], v[4]);
}

/* ---------------- direction check: a short push each way, hands off ----------------
 * 0-300 ms nothing (baseline), 300-550 ms +level, 550-900 ms nothing, 900-1150 ms -level,
 * then 1 s of centring spring. Each push must move the steering axis (axis 0) by at least
 * 3 % of its range, in opposite directions. */
#define CAL_LEVEL 0.2f
static struct { bool running; Uint64 t0; float base, a1, mid, a2; char result[16]; } cal;

static float steer_axis(void) { return dev.joy && SDL_GetNumJoystickAxes(dev.joy) > 0 ? SDL_GetJoystickAxis(dev.joy, 0) / 32767.0f : 0; }

static void start_calibration(void) {
    if (!ffb_has_wheel(&dev) || dev.eff_const < 0) { SDL_strlcpy(cal.result, "unsupported", sizeof cal.result); return; }
    memset(&cal, 0, sizeof cal);
    cal.running = true;
    cal.t0 = SDL_GetTicks();
    test_until = 0;
    SDL_Log("direction check started on %s", dev.name);
}

static void calibration_tick(void) {
    Uint64 t = SDL_GetTicks() - cal.t0;
    float v[5] = {0};
    if (t < 300) cal.base = steer_axis();
    else if (t < 550) { cal.a1 = steer_axis(); ffb_apply(&dev, CAL_LEVEL, 0, 0, 0, 0); memset(out, 0, sizeof out); return; }
    else if (t < 900) cal.mid = steer_axis();
    else if (t < 1150) { cal.a2 = steer_axis(); ffb_apply(&dev, -CAL_LEVEL, 0, 0, 0, 0); memset(out, 0, sizeof out); return; }
    else if (t < 2150) v[1] = 0.5f;   /* back towards the centre */
    else {
        cal.running = false;
        float d1 = cal.a1 - cal.base, d2 = cal.a2 - cal.mid;
        SDL_Log("direction check: +level moved %.3f, -level moved %.3f", d1, d2);
        if (fabsf(d1) >= 0.03f && fabsf(d2) >= 0.03f && (d1 > 0) != (d2 > 0)) {
            wheel_dir_set(dev.name, d1 > 0 ? 1 : -1);
            save_settings();
            SDL_strlcpy(cal.result, "ok", sizeof cal.result);
        } else SDL_strlcpy(cal.result, "nomove", sizeof cal.result);
    }
    memcpy(out, v, sizeof out);
    ffb_apply(&dev, 0, v[1], 0, 0, 0);
}

static void tick(void) {
    Uint64 now = SDL_GetTicks();
    if (cal.running) {
        if (dev.joy) { calibration_tick(); return; }
        cal.running = false;
    }
    if (test_until) {
        if (now < test_until) { play(test_v); memcpy(out, test_v, sizeof out); return; }
        test_until = 0;
    }
    Peer *p = owner >= 0 && peers[owner].used ? &peers[owner] : NULL;
    /* A page that stops talking (frozen tab, sleep) must not leave a force on the wheel. */
    bool live = p && p->live && now - p->last_ms < 300 && S.enabled;
    if (!live) {
        smoothed = 0;
        memset(out, 0, sizeof out);
    } else {
        float s = clampf(S.strength, 0, 1.5f);
        float k = p->f[0] * S.constantGain * (game_invert(p->game) ? -1.0f : 1.0f);
        float mf = clampf(S.minForce, 0, 0.5f);
        if (fabsf(k) > 0.003f && mf > 0) k = (k < 0 ? -1.0f : 1.0f) * (mf + (1 - mf) * fminf(1, fabsf(k)));
        float a = clampf(S.smoothing, 0, 0.95f);
        smoothed += (k - smoothed) * (1 - a);
        float base = clampf(S.minSpring, 0, 1);
        out[0] = clampf(smoothed * s, -1, 1);
        out[1] = clampf(fmaxf(p->f[1] * S.springGain, base) * s, 0, 1);
        out[2] = clampf(p->f[2] * S.damperGain * s, 0, 1);
        out[3] = clampf(p->f[3] * S.frictionGain * s, 0, 1);
        out[4] = clampf(p->f[4] * S.rumbleGain * s, 0, 1);
    }
    play(out);

    /* Every 10 s of racing, one log line: enough to see in a report what reached the wheel. */
    static struct { Uint64 t0; int ticks, live; float raw, wheel, spring, rumble; } st;
    if (!st.t0) st.t0 = now;
    st.ticks++;
    if (live) {
        st.live++;
        st.raw = fmaxf(st.raw, fabsf(p->f[0]));
        st.wheel = fmaxf(st.wheel, fabsf(out[0]));
        st.spring = fmaxf(st.spring, out[1]);
        st.rumble = fmaxf(st.rumble, out[4]);
    }
    if (now - st.t0 >= 10000) {
        if (st.live)
            SDL_Log("ffb %s: live %d%%, torque max game %.2f -> wheel %.2f (level sign %+d%s), spring %.2f, vibration %.2f, wheel %s, update errors %u",
                    p ? p->game : "?", st.live * 100 / (st.ticks ? st.ticks : 1), st.raw, st.wheel, right_sign(),
                    dev.joy && wheel_dir_get(dev.name) ? " measured" : " default", st.spring, st.rumble,
                    ffb_has_wheel(&dev) ? dev.name : "none", (unsigned)dev.update_errors);
        memset(&st, 0, sizeof st);
        st.t0 = now;
    }
}

/* ---------------- settings page state ---------------- */
static void broadcast_state(void) {
    static char js[16384];
    size_t j = 0;
#define PUT(...) do { if (j < sizeof js) j += (size_t)snprintf(js + j, sizeof js - j, __VA_ARGS__); } while (0)
    Uint64 now = SDL_GetTicks();
    int v = SDL_GetVersion();
    PUT("state {\"version\":\"%s\",\"sdl\":\"%d.%d.%d\",\"port\":%d,", HELPER_VERSION,
        SDL_VERSIONNUM_MAJOR(v), SDL_VERSIONNUM_MINOR(v), SDL_VERSIONNUM_MICRO(v), PORT);
    /* games */
    PUT("\"games\":[");
    bool first = true;
    for (int i = 0; i < MAX_CLIENTS; i++) {
        Peer *p = &peers[i];
        if (!p->used || p->kind != CLIENT_GAME) continue;
        char org[256];
        json_escape(p->origin, org, sizeof org);
        PUT("%s{\"id\":\"%s\",\"origin\":\"%s\",\"live\":%s,\"active\":%s,\"age\":%llu,\"raw\":[%.3f,%.3f,%.3f,%.3f,%.3f]}",
            first ? "" : ",", p->game, org, p->live && now - p->last_ms < 300 ? "true" : "false", i == owner ? "true" : "false",
            (unsigned long long)(now - p->last_ms), p->f[0], p->f[1], p->f[2], p->f[3], p->f[4]);
        first = false;
    }
    PUT("],\"out\":[%.3f,%.3f,%.3f,%.3f,%.3f],\"testing\":%s,", out[0], out[1], out[2], out[3], out[4], test_until ? "true" : "false");
    PUT("\"calib\":{\"running\":%s,\"result\":\"%s\"},", cal.running ? "true" : "false", cal.result);
    /* device */
    if (dev.joy) {
        char name[256], fj[256];
        json_escape(dev.name, name, sizeof name);
        ffb_features_json(dev.features, fj, sizeof fj);
        PUT("\"device\":{\"name\":\"%s\",\"wheel\":%s,\"features\":%s,\"dir\":%d,\"axes\":[", name, ffb_has_wheel(&dev) ? "true" : "false", fj, wheel_dir_get(dev.name));
        int na = SDL_GetNumJoystickAxes(dev.joy);
        for (int i = 0; i < na && i < 8; i++) PUT("%s%.3f", i ? "," : "", SDL_GetJoystickAxis(dev.joy, i) / 32767.0f);
        PUT("]},");
    } else PUT("\"device\":null,");
    FfbDeviceInfo *list = dev_list;
    int n = dev_count;
    PUT("\"devices\":[");
    for (int i = 0; i < n; i++) {
        char name[256];
        json_escape(list[i].name, name, sizeof name);
        PUT("%s{\"name\":\"%s\",\"haptic\":%s,\"constant\":%s}", i ? "," : "", name, list[i].haptic ? "true" : "false",
            (list[i].features & SDL_HAPTIC_CONSTANT) ? "true" : "false");
    }
    PUT("],\"settings\":{");
    for (int i = 0; i < NFIELDS; i++) {
        void *p = (char *)&S + FIELDS[i].off;
        if (FIELDS[i].t == T_BOOL) PUT("\"%s\":%s,", FIELDS[i].key, *(bool *)p ? "true" : "false");
        else if (FIELDS[i].t == T_INT) PUT("\"%s\":%d,", FIELDS[i].key, *(int *)p);
        else PUT("\"%s\":%.3f,", FIELDS[i].key, *(float *)p);
    }
    char devname[256], origins[1024];
    json_escape(S.device, devname, sizeof devname);
    json_escape(S.origins, origins, sizeof origins);
    PUT("\"device\":\"%s\",\"origins\":\"%s\"}}", devname, origins);
#undef PUT
    for (int i = 0; i < MAX_CLIENTS; i++) if (peers[i].used && peers[i].kind == CLIENT_UI) server_send(i, js, j < sizeof js ? j : sizeof js - 1);
    if (device_changed) {
        device_changed = false;
        for (int i = 0; i < MAX_CLIENTS; i++) if (peers[i].used && peers[i].kind == CLIENT_GAME && peers[i].game[0]) send_hi(i);
    }
}

/* ---------------- problem report (GET /report) ----------------
 * A text file the player downloads from the settings page and attaches to a GitHub issue.
 * Nothing is sent anywhere by the helper. Paths under the user's home folder become "~". */
typedef struct { char *p; size_t len, cap; } Buf;
static void bput(Buf *b, const char *fmt, ...) {
    va_list ap;
    for (;;) {
        va_start(ap, fmt);
        int n = vsnprintf(b->p + b->len, b->cap - b->len, fmt, ap);
        va_end(ap);
        if (n < 0) return;
        if (b->len + (size_t)n < b->cap) { b->len += (size_t)n; return; }
        size_t cap = (b->cap + (size_t)n) * 2;
        char *q = realloc(b->p, cap);
        if (!q) return;
        b->p = q; b->cap = cap;
    }
}

static void tail_file(Buf *b, const char *path, int lines) {
    FILE *f = fopen(path, "rb");
    if (!f) { bput(b, "  (none)\n"); return; }
    fseek(f, 0, SEEK_END);
    long size = ftell(f);
    long from = size > 200000 ? size - 200000 : 0;
    fseek(f, from, SEEK_SET);
    char *t = malloc((size_t)(size - from) + 1);
    size_t n = t ? fread(t, 1, (size_t)(size - from), f) : 0;
    fclose(f);
    if (!t) return;
    t[n] = 0;
    char *start = t + n;
    for (int k = 0; start > t && k <= lines; ) if (*--start == '\n') k++;
    if (*start == '\n') start++;
    bput(b, "%s", start);
    free(t);
}

static void replace_all(Buf *b, const char *what, const char *with) {
    size_t wl = strlen(what), nl = strlen(with);
    if (!wl || nl > wl) return;
    char *s = b->p;
    while ((s = strstr(s, what))) {
        memcpy(s, with, nl);
        memmove(s + nl, s + wl, (size_t)(b->p + b->len - (s + wl)) + 1);
        b->len -= wl - nl;
        s += nl;
    }
}

static bool http_get(const char *path, HttpBody *r) {
    if (strcmp(path, "/report") && strncmp(path, "/report?", 8)) return false;
    Buf b = {malloc(65536), 0, 65536};
    if (!b.p) return false;
    b.p[0] = 0;
    char now[32], os[96];
    clock_text(now, sizeof now, true);
    os_version(os, sizeof os);
    int v = SDL_GetVersion();
    bput(&b, "Arcade FFB Helper problem report\n================================\n");
    bput(&b, "Created: %s\nHelper:  %s, SDL %d.%d.%d\nSystem:  %s\nRunning: %llu s\n\n", now, HELPER_VERSION,
         SDL_VERSIONNUM_MAJOR(v), SDL_VERSIONNUM_MINOR(v), SDL_VERSIONNUM_MICRO(v), os, (unsigned long long)(SDL_GetTicks() / 1000));

    bput(&b, "Wheel in use\n");
    if (dev.joy) {
        char fj[256];
        ffb_features_json(dev.features, fj, sizeof fj);
        int ws = wheel_dir_get(dev.name);
        bput(&b, "  %s [%04x:%04x], axes %d, buttons %d\n", dev.name, SDL_GetJoystickVendor(dev.joy), SDL_GetJoystickProduct(dev.joy),
             SDL_GetNumJoystickAxes(dev.joy), SDL_GetNumJoystickButtons(dev.joy));
        bput(&b, "  haptic %s, features %s\n", dev.haptic ? "yes" : "no", fj);
        bput(&b, "  effects running: constant %d, spring %d, damper %d, friction %d, sine %d, rumble %d; update errors %u\n",
             dev.eff_const >= 0, dev.eff_spring >= 0, dev.eff_damper >= 0, dev.eff_friction >= 0, dev.eff_sine >= 0, dev.rumble_api,
             (unsigned)dev.update_errors);
        bput(&b, "  force direction: %s (level sign for right %+d); last check: %s\n", ws ? "measured" : "not measured, default",
             right_sign(), cal.result[0] ? cal.result : "none this session");
        bput(&b, "  steering axis now: %.3f\n", steer_axis());
    } else bput(&b, "  none\n");

    bput(&b, "\nDevices SDL sees\n");
    for (int i = 0; i < dev_count; i++) {
        char fj[256];
        ffb_features_json(dev_list[i].features, fj, sizeof fj);
        bput(&b, "  %s [%04x:%04x], haptic %s %s\n", dev_list[i].name, dev_list[i].vendor, dev_list[i].product, dev_list[i].haptic ? "yes" : "no", fj);
    }
    if (!dev_count) bput(&b, "  none\n");

    bput(&b, "\nGames connected\n");
    int games = 0;
    Uint64 t = SDL_GetTicks();
    for (int i = 0; i < MAX_CLIENTS; i++) {
        Peer *p = &peers[i];
        if (!p->used || p->kind != CLIENT_GAME) continue;
        games++;
        bput(&b, "  %s from %s, %s, last message %llu ms ago, forces %.3f %.3f %.3f %.3f %.3f%s\n", p->game[0] ? p->game : "?", p->origin,
             p->live ? "racing" : "menu/pause", (unsigned long long)(t - p->last_ms), p->f[0], p->f[1], p->f[2], p->f[3], p->f[4],
             i == owner ? " (drives the wheel)" : "");
    }
    if (!games) bput(&b, "  none\n");
    bput(&b, "  to the wheel now: torque %.3f, spring %.3f, damper %.3f, friction %.3f, vibration %.3f\n", out[0], out[1], out[2], out[3], out[4]);

    bput(&b, "\nSettings\n");
    for (int i = 0; i < NFIELDS; i++) {
        void *p = (char *)&S + FIELDS[i].off;
        if (FIELDS[i].t == T_BOOL) bput(&b, "  %s=%d\n", FIELDS[i].key, *(bool *)p ? 1 : 0);
        else if (FIELDS[i].t == T_INT) bput(&b, "  %s=%d\n", FIELDS[i].key, *(int *)p);
        else bput(&b, "  %s=%.3f\n", FIELDS[i].key, *(float *)p);
    }
    bput(&b, "  device=%s\n  origins=%s\n", S.device[0] ? S.device : "(automatic)", S.origins);
    for (int i = 0; i < n_wheel_dirs; i++) bput(&b, "  direction=%+d|%s\n", wheel_dirs[i].right_sign, wheel_dirs[i].name);

    bput(&b, "\nLog, this session (last %d lines)\n", log_count);
    for (int i = 0; i < log_count; i++) bput(&b, "  %s\n", log_ring[(log_next - log_count + i + LOG_LINES) % LOG_LINES]);
    char prev[1100];
    snprintf(prev, sizeof prev, "%shelper-previous.log", pref_dir);
    bput(&b, "\nLog, previous session (last 300 lines)\n");
    tail_file(&b, prev, 300);

    /* No user folder names in a file meant to be shared. */
    replace_all(&b, pref_dir, "<settings>/");
    char *home = SDL_GetUserFolder(SDL_FOLDER_HOME) ? SDL_strdup(SDL_GetUserFolder(SDL_FOLDER_HOME)) : NULL;
    if (home) {
        size_t hl = strlen(home);
        while (hl && (home[hl - 1] == '\\' || home[hl - 1] == '/')) home[--hl] = 0;
        if (hl > 3) replace_all(&b, home, "~");
        SDL_free(home);
    }

    char day[32];
    clock_text(day, sizeof day, true);
    for (char *c = day; *c; c++) if (*c == ' ' || *c == ':') *c = '-';
    r->type = "text/plain; charset=utf-8";
    r->body = b.p;
    r->len = b.len;
    snprintf(r->filename, sizeof r->filename, "arcade-ffb-helper-report-%s.txt", day);
    return true;
}

/* ---------------- tray ---------------- */
static void open_settings(void) {
    char url[64];
    snprintf(url, sizeof url, "http://127.0.0.1:%d/", PORT);
    SDL_OpenURL(url);
}
static void SDLCALL tray_open(void *u, SDL_TrayEntry *e) { (void)u; (void)e; open_settings(); }
static void SDLCALL tray_quit(void *u, SDL_TrayEntry *e) { (void)u; (void)e; running = false; }

/* The launcher's icon (three stripes on navy), drawn at 32 px. */
static SDL_Surface *make_icon(void) {
    const int N = 32;
    SDL_Surface *s = SDL_CreateSurface(N, N, SDL_PIXELFORMAT_RGBA32);
    if (!s) return NULL;
    static const float stripes[3][4][2] = {
        {{12.5f, 78}, {27.5f, 78}, {51.5f, 22}, {36.5f, 22}},
        {{30.5f, 78}, {45.5f, 78}, {69.5f, 22}, {54.5f, 22}},
        {{48.5f, 78}, {63.5f, 78}, {87.5f, 22}, {72.5f, 22}},
    };
    static const Uint8 col[3][3] = {{0xe8, 0x35, 0x2b}, {0x1e, 0x7b, 0xff}, {0xff, 0xb0, 0x00}};
    Uint8 *px = s->pixels;
    for (int y = 0; y < N; y++) for (int x = 0; x < N; x++) {
        float acc[4] = {0};
        for (int sy = 0; sy < 4; sy++) for (int sx = 0; sx < 4; sx++) {
            float u = (x + (sx + 0.5f) / 4) * 100.0f / N, w = (y + (sy + 0.5f) / 4) * 100.0f / N;
            /* rounded square, radius 22 */
            float cx = fminf(fmaxf(u, 22), 78), cy = fminf(fmaxf(w, 22), 78);
            if ((u - cx) * (u - cx) + (w - cy) * (w - cy) > 22 * 22) continue;
            Uint8 r = 0x0d, g = 0x12, b = 0x20;
            for (int k = 0; k < 3; k++) {
                const float (*q)[2] = stripes[k];
                if (w < 22 || w > 78) continue;
                float t = (78 - w) / 56.0f;                 /* 0 at the bottom, 1 at the top */
                float left = q[0][0] + (q[3][0] - q[0][0]) * t, right = q[1][0] + (q[2][0] - q[1][0]) * t;
                if (u >= left && u <= right) { r = col[k][0]; g = col[k][1]; b = col[k][2]; }
            }
            acc[0] += r; acc[1] += g; acc[2] += b; acc[3] += 255;
        }
        Uint8 *p = px + y * s->pitch + x * 4;
        float a = acc[3] / 16;
        p[3] = (Uint8)a;
        for (int c = 0; c < 3; c++) p[c] = a > 0 ? (Uint8)(acc[c] / (acc[3] / 255)) : 0;
    }
    return s;
}

int main(int argc, char **argv) {
    bool background = false;
    for (int i = 1; i < argc; i++) if (!strcmp(argv[i], "--background")) background = true;

    SDL_SetHint(SDL_HINT_JOYSTICK_ALLOW_BACKGROUND_EVENTS, "1");
    SDL_SetHint(SDL_HINT_JOYSTICK_RAWINPUT, "0"); /* the DirectInput path carries wheel FFB */
    SDL_SetHint(SDL_HINT_VIDEO_ALLOW_SCREENSAVER, "1");
    SDL_SetAppMetadata("Arcade FFB Helper", HELPER_VERSION, "local.arcade.ffbhelper");

    char *pp = SDL_GetPrefPath(NULL, "Arcade FFB Helper");
    if (pp) { SDL_strlcpy(pref_dir, pp, sizeof pref_dir); SDL_free(pp); }
    SDL_SetLogOutputFunction(log_out, NULL);
    load_settings();

    ServerConfig cfg = {allow_game_origin, on_open, on_text, on_close, UI_PAGE, sizeof UI_PAGE - 1, http_get};
    if (!server_start(PORT, &cfg)) {
        /* Port taken: most likely the helper is already running. Show its page. */
        if (!background) open_settings();
        return 0;
    }
    /* Only the running helper owns the log: keep the previous session's for the report. */
    char lp[1100], prev[1100];
    snprintf(lp, sizeof lp, "%shelper.log", pref_dir);
    snprintf(prev, sizeof prev, "%shelper-previous.log", pref_dir);
    SDL_RemovePath(prev);
    SDL_RenamePath(lp, prev);
    log_file = fopen(lp, "wb");
    char os[96], started[32];
    os_version(os, sizeof os);
    clock_text(started, sizeof started, true);
    SDL_Log("started %s on %s", started, os);
    if (!SDL_Init(SDL_INIT_VIDEO | SDL_INIT_JOYSTICK | SDL_INIT_HAPTIC | SDL_INIT_EVENTS)) {
        SDL_Log("SDL_Init: %s", SDL_GetError());
        SDL_ShowSimpleMessageBox(SDL_MESSAGEBOX_ERROR, "Arcade FFB Helper", SDL_GetError(), NULL);
        return 1;
    }
    int v = SDL_GetVersion();
    SDL_Log("Arcade FFB Helper %s, SDL %d.%d.%d, http://127.0.0.1:%d/", HELPER_VERSION,
            SDL_VERSIONNUM_MAJOR(v), SDL_VERSIONNUM_MINOR(v), SDL_VERSIONNUM_MICRO(v), PORT);

    SDL_Surface *icon = make_icon();
    SDL_Tray *tray = SDL_CreateTray(icon, "Arcade FFB Helper");
    if (tray) {
        SDL_TrayMenu *menu = SDL_CreateTrayMenu(tray);
        SDL_TrayEntry *e = SDL_InsertTrayEntryAt(menu, -1, "Force feedback settings", SDL_TRAYENTRY_BUTTON);
        SDL_SetTrayEntryCallback(e, tray_open, NULL);
        SDL_InsertTrayEntryAt(menu, -1, NULL, SDL_TRAYENTRY_BUTTON); /* separator */
        e = SDL_InsertTrayEntryAt(menu, -1, "Quit", SDL_TRAYENTRY_BUTTON);
        SDL_SetTrayEntryCallback(e, tray_quit, NULL);
    } else SDL_Log("tray: %s", SDL_GetError());

    ffb_init(&dev);
    open_wanted_device();
    if (!background && S.openOnStart) open_settings();

    Uint64 last_tick = 0, last_state = 0;
    while (running) {
        SDL_Event ev;
        while (SDL_PollEvent(&ev)) {
            if (ev.type == SDL_EVENT_QUIT) running = false;
            else if (ev.type == SDL_EVENT_JOYSTICK_ADDED && !dev.joy) open_wanted_device();
            else if (ev.type == SDL_EVENT_JOYSTICK_ADDED && S.device[0] && strcmp(dev.name, S.device) != 0) open_wanted_device();
            else if (ev.type == SDL_EVENT_JOYSTICK_REMOVED && dev.joy && ev.jdevice.which == dev.id) {
                SDL_Log("device removed");
                ffb_close(&dev);
                open_wanted_device();
            } else if (ev.type == SDL_EVENT_JOYSTICK_ADDED || ev.type == SDL_EVENT_JOYSTICK_REMOVED) refresh_list();
        }
        Uint64 now = SDL_GetTicksNS();
        Uint64 elapsed = now - last_tick;
        server_poll(elapsed >= 8000000ull ? 0 : (int)((8000000ull - elapsed) / 1000000ull));
        now = SDL_GetTicksNS();
        if (now - last_tick >= 8000000ull) { last_tick = now; SDL_UpdateJoysticks(); tick(); }
        if (now - last_state >= 50000000ull) { last_state = now; broadcast_state(); }
    }
    ffb_apply(&dev, 0, 0, 0, 0, 0);
    ffb_close(&dev);
    server_stop();
    if (tray) SDL_DestroyTray(tray);
    if (icon) SDL_DestroySurface(icon);
    SDL_Quit();
    if (log_file) fclose(log_file);
    return 0;
}
