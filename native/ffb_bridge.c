/*
 * ffb_bridge.exe - SDL3 force-feedback + wheel input bridge for Arcade Launcher.
 *
 * Talks to the Electron main process over stdin/stdout using line-based text.
 *
 * Commands (stdin, one per line):
 *   list                         -> re-enumerate devices, prints "devices <json>"
 *   open <instance_id>           -> open a joystick (0 = first haptic-capable device)
 *   ffb <const> <spring> <damper> <friction> <rumble> <center>
 *        const   : -1..1   constant force (positive = pushes wheel to the right)
 *        spring  :  0..1   centering spring strength
 *        damper  :  0..1   damper strength
 *        friction:  0..1   friction strength
 *        rumble  :  0..1   periodic vibration (road / off-road / collision)
 *        center  : -1..1   spring center offset
 *   gain <0..100>                -> global device gain
 *   autocenter <0..100>          -> device autocenter (0 = off, recommended)
 *   stop                         -> stop all effects
 *   rate <hz>                    -> input report rate (default 250)
 *   quit
 *
 * Output (stdout):
 *   ready <sdl_version>
 *   devices [{"id":..,"name":"..","axes":..,"buttons":..,"hats":..,"haptic":true,"features":[..]}]
 *   opened <id> <json-info>
 *   input <id> a:<f,f,...> b:<0101..> h:<n,n>
 *   log <text>
 *   error <text>
 */
#define SDL_MAIN_HANDLED
#include <SDL3/SDL.h>
#include <stdio.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

#ifdef _WIN32
#include <windows.h>
/* Ask hybrid-GPU drivers for the dedicated GPU (harmless on desktop). */
__declspec(dllexport) DWORD NvOptimusEnablement = 0x00000001;
__declspec(dllexport) int AmdPowerXpressRequestHighPerformance = 1;
#endif

typedef struct {
    SDL_Joystick *joy;
    SDL_Haptic *haptic;
    SDL_JoystickID id;
    Uint32 features;
    int eff_const, eff_spring, eff_damper, eff_friction, eff_sine, eff_rumble;
    SDL_HapticEffect e_const, e_spring, e_damper, e_friction, e_sine;
    bool rumble_api;
    float last_rumble;
    Uint64 last_rumble_ms;
} Device;

static Device dev;
static SDL_Mutex *cmd_lock;
static char cmd_queue[64][256];
static int cmd_head = 0, cmd_tail = 0;
static volatile bool running = true;
static int input_hz = 250;

/* ---------------- stdin reader thread ---------------- */
static int SDLCALL stdin_thread(void *unused) {
    (void)unused;
    char line[256];
    while (running && fgets(line, sizeof line, stdin)) {
        size_t n = strlen(line);
        while (n && (line[n - 1] == '\n' || line[n - 1] == '\r')) line[--n] = 0;
        if (n >= 3 && (unsigned char)line[0] == 0xEF && (unsigned char)line[1] == 0xBB && (unsigned char)line[2] == 0xBF) {
            memmove(line, line + 3, n - 2); /* strip UTF-8 BOM */
            n -= 3;
        }
        if (!n) continue;
        SDL_LockMutex(cmd_lock);
        int next = (cmd_tail + 1) % 64;
        if (next == cmd_head) cmd_head = (cmd_head + 1) % 64; /* drop oldest */
        memcpy(cmd_queue[cmd_tail], line, n + 1);
        cmd_tail = next;
        SDL_UnlockMutex(cmd_lock);
    }
    /* stdin closed: parent is gone */
    SDL_LockMutex(cmd_lock);
    strcpy(cmd_queue[cmd_tail], "quit");
    cmd_tail = (cmd_tail + 1) % 64;
    SDL_UnlockMutex(cmd_lock);
    return 0;
}

static bool pop_cmd(char *out) {
    bool ok = false;
    SDL_LockMutex(cmd_lock);
    if (cmd_head != cmd_tail) {
        strcpy(out, cmd_queue[cmd_head]);
        cmd_head = (cmd_head + 1) % 64;
        ok = true;
    }
    SDL_UnlockMutex(cmd_lock);
    return ok;
}

/* ---------------- helpers ---------------- */
static void out(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    vfprintf(stdout, fmt, ap);
    va_end(ap);
    fputc('\n', stdout);
    fflush(stdout);
}

static void json_escape(const char *s, char *dst, size_t cap) {
    size_t j = 0;
    for (; s && *s && j + 2 < cap; s++) {
        if (*s == '"' || *s == '\\') dst[j++] = '\\';
        dst[j++] = ((unsigned char)*s < 0x20) ? ' ' : *s;
    }
    dst[j] = 0;
}

static float clampf(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }

static void features_json(Uint32 f, char *buf, size_t cap) {
    static const struct { Uint32 bit; const char *name; } map[] = {
        {SDL_HAPTIC_CONSTANT, "constant"}, {SDL_HAPTIC_SINE, "sine"},
        {SDL_HAPTIC_SPRING, "spring"},     {SDL_HAPTIC_DAMPER, "damper"},
        {SDL_HAPTIC_FRICTION, "friction"}, {SDL_HAPTIC_LEFTRIGHT, "leftright"},
        {SDL_HAPTIC_GAIN, "gain"},         {SDL_HAPTIC_AUTOCENTER, "autocenter"},
    };
    size_t j = 0;
    buf[j++] = '[';
    bool first = true;
    for (size_t i = 0; i < sizeof map / sizeof map[0]; i++) {
        if (f & map[i].bit) {
            j += (size_t)snprintf(buf + j, cap - j, "%s\"%s\"", first ? "" : ",", map[i].name);
            first = false;
        }
    }
    snprintf(buf + j, cap - j, "]");
}

static void list_devices(void) {
    int count = 0;
    SDL_JoystickID *ids = SDL_GetJoysticks(&count);
    char buf[8192];
    size_t j = 0;
    j += (size_t)snprintf(buf + j, sizeof buf - j, "devices [");
    for (int i = 0; i < count; i++) {
        SDL_JoystickID id = ids[i];
        bool temp_open = !(dev.joy && dev.id == id);
        SDL_Joystick *js = temp_open ? SDL_OpenJoystick(id) : dev.joy;
        if (!js) continue;
        char name[256];
        json_escape(SDL_GetJoystickName(js), name, sizeof name);
        bool haptic = SDL_IsJoystickHaptic(js);
        Uint32 feats = 0;
        if (haptic) {
            if (!temp_open && dev.haptic) feats = dev.features;
            else {
                SDL_Haptic *h = SDL_OpenHapticFromJoystick(js);
                if (h) { feats = SDL_GetHapticFeatures(h); SDL_CloseHaptic(h); }
            }
        }
        char fj[256];
        features_json(feats, fj, sizeof fj);
        j += (size_t)snprintf(buf + j, sizeof buf - j,
            "%s{\"id\":%u,\"name\":\"%s\",\"vendor\":%u,\"product\":%u,\"axes\":%d,\"buttons\":%d,\"hats\":%d,\"haptic\":%s,\"features\":%s,\"open\":%s}",
            i ? "," : "", (unsigned)id, name,
            (unsigned)SDL_GetJoystickVendor(js), (unsigned)SDL_GetJoystickProduct(js),
            SDL_GetNumJoystickAxes(js), SDL_GetNumJoystickButtons(js), SDL_GetNumJoystickHats(js),
            haptic ? "true" : "false", fj, temp_open ? "false" : "true");
        if (temp_open) SDL_CloseJoystick(js);
        if (j >= sizeof buf - 512) break;
    }
    snprintf(buf + j, sizeof buf - j, "]");
    SDL_free(ids);
    out("%s", buf);
}

static void close_device(void) {
    if (dev.haptic) {
        SDL_StopHapticEffects(dev.haptic);
        SDL_CloseHaptic(dev.haptic);
    }
    if (dev.joy) SDL_CloseJoystick(dev.joy);
    memset(&dev, 0, sizeof dev);
    dev.eff_const = dev.eff_spring = dev.eff_damper = dev.eff_friction = dev.eff_sine = -1;
}

static SDL_HapticDirection steering_dir(void) {
    SDL_HapticDirection d;
    memset(&d, 0, sizeof d);
    d.type = SDL_HAPTIC_STEERING_AXIS;
    d.dir[0] = 1;
    return d;
}

static int make_effect(SDL_HapticEffect *e) {
    if (!SDL_HapticEffectSupported(dev.haptic, e)) return -1;
    int id = SDL_CreateHapticEffect(dev.haptic, e);
    if (id < 0) { out("log effect type %u create failed: %s", (unsigned)e->type, SDL_GetError()); return -1; }
    if (!SDL_RunHapticEffect(dev.haptic, id, SDL_HAPTIC_INFINITY)) {
        out("log effect type %u run failed: %s", (unsigned)e->type, SDL_GetError());
    }
    return id;
}

static void setup_effects(void) {
    SDL_HapticDirection dir = steering_dir();
    /* Some drivers reject STEERING_AXIS; fall back to cartesian X. */
    SDL_HapticEffect probe;
    memset(&probe, 0, sizeof probe);
    probe.type = SDL_HAPTIC_CONSTANT;
    probe.constant.direction = dir;
    probe.constant.length = SDL_HAPTIC_INFINITY;
    if ((dev.features & SDL_HAPTIC_CONSTANT) && !SDL_HapticEffectSupported(dev.haptic, &probe)) {
        memset(&dir, 0, sizeof dir);
        dir.type = SDL_HAPTIC_CARTESIAN;
        dir.dir[0] = 1;
    }

    if (dev.features & SDL_HAPTIC_CONSTANT) {
        memset(&dev.e_const, 0, sizeof dev.e_const);
        dev.e_const.type = SDL_HAPTIC_CONSTANT;
        dev.e_const.constant.direction = dir;
        dev.e_const.constant.length = SDL_HAPTIC_INFINITY;
        dev.e_const.constant.level = 0;
        dev.eff_const = make_effect(&dev.e_const);
    }
    SDL_HapticEffectType cond_types[3] = {SDL_HAPTIC_SPRING, SDL_HAPTIC_DAMPER, SDL_HAPTIC_FRICTION};
    SDL_HapticEffect *cond_e[3] = {&dev.e_spring, &dev.e_damper, &dev.e_friction};
    int *cond_id[3] = {&dev.eff_spring, &dev.eff_damper, &dev.eff_friction};
    for (int i = 0; i < 3; i++) {
        if (!(dev.features & cond_types[i])) continue;
        SDL_HapticEffect *e = cond_e[i];
        memset(e, 0, sizeof *e);
        e->type = cond_types[i];
        e->condition.direction = dir;
        e->condition.length = SDL_HAPTIC_INFINITY;
        e->condition.right_sat[0] = e->condition.left_sat[0] = 0xFFFF;
        e->condition.right_coeff[0] = e->condition.left_coeff[0] = 0;
        *cond_id[i] = make_effect(e);
    }
    if (dev.features & SDL_HAPTIC_SINE) {
        memset(&dev.e_sine, 0, sizeof dev.e_sine);
        dev.e_sine.type = SDL_HAPTIC_SINE;
        dev.e_sine.periodic.direction = dir;
        dev.e_sine.periodic.length = SDL_HAPTIC_INFINITY;
        dev.e_sine.periodic.period = 40; /* 25 Hz road buzz */
        dev.e_sine.periodic.magnitude = 0;
        dev.eff_sine = make_effect(&dev.e_sine);
    }
    if (dev.eff_sine < 0 && SDL_HapticRumbleSupported(dev.haptic)) {
        dev.rumble_api = SDL_InitHapticRumble(dev.haptic);
    }
}

static void open_device(SDL_JoystickID want) {
    close_device();
    int count = 0;
    SDL_JoystickID *ids = SDL_GetJoysticks(&count);
    SDL_JoystickID pick = 0;
    if (want) {
        for (int i = 0; i < count; i++) if (ids[i] == want) pick = want;
    } else {
        /* prefer the first haptic device that supports constant force (a wheel) */
        for (int pass = 0; pass < 2 && !pick; pass++) {
            for (int i = 0; i < count && !pick; i++) {
                SDL_Joystick *js = SDL_OpenJoystick(ids[i]);
                if (!js) continue;
                if (SDL_IsJoystickHaptic(js)) {
                    SDL_Haptic *h = SDL_OpenHapticFromJoystick(js);
                    Uint32 f = h ? SDL_GetHapticFeatures(h) : 0;
                    if (h) SDL_CloseHaptic(h);
                    if (pass == 1 || (f & SDL_HAPTIC_CONSTANT)) pick = ids[i];
                } else if (pass == 1) pick = ids[i];
                SDL_CloseJoystick(js);
            }
        }
    }
    SDL_free(ids);
    if (!pick) { out("error no joystick found"); return; }

    dev.joy = SDL_OpenJoystick(pick);
    if (!dev.joy) { out("error open joystick: %s", SDL_GetError()); return; }
    dev.id = pick;
    if (SDL_IsJoystickHaptic(dev.joy)) {
        dev.haptic = SDL_OpenHapticFromJoystick(dev.joy);
        if (dev.haptic) {
            dev.features = SDL_GetHapticFeatures(dev.haptic);
            if (dev.features & SDL_HAPTIC_AUTOCENTER) SDL_SetHapticAutocenter(dev.haptic, 0);
            if (dev.features & SDL_HAPTIC_GAIN) SDL_SetHapticGain(dev.haptic, 100);
            setup_effects();
        } else {
            out("log haptic open failed: %s", SDL_GetError());
        }
    }
    char name[256], fj[256];
    json_escape(SDL_GetJoystickName(dev.joy), name, sizeof name);
    features_json(dev.features, fj, sizeof fj);
    out("opened %u {\"id\":%u,\"name\":\"%s\",\"axes\":%d,\"buttons\":%d,\"hats\":%d,\"haptic\":%s,\"features\":%s,\"effects\":{\"constant\":%s,\"spring\":%s,\"damper\":%s,\"friction\":%s,\"sine\":%s,\"rumble\":%s}}",
        (unsigned)dev.id, (unsigned)dev.id, name,
        SDL_GetNumJoystickAxes(dev.joy), SDL_GetNumJoystickButtons(dev.joy), SDL_GetNumJoystickHats(dev.joy),
        dev.haptic ? "true" : "false", fj,
        dev.eff_const >= 0 ? "true" : "false", dev.eff_spring >= 0 ? "true" : "false",
        dev.eff_damper >= 0 ? "true" : "false", dev.eff_friction >= 0 ? "true" : "false",
        dev.eff_sine >= 0 ? "true" : "false", dev.rumble_api ? "true" : "false");
}

static void set_condition(int id, SDL_HapticEffect *e, float strength, float center) {
    if (id < 0) return;
    Sint16 coeff = (Sint16)(clampf(strength, 0, 1) * 32767.0f);
    Sint16 c = (Sint16)(clampf(center, -1, 1) * 32767.0f);
    if (e->condition.right_coeff[0] == coeff && e->condition.center[0] == c) return;
    e->condition.right_coeff[0] = e->condition.left_coeff[0] = coeff;
    e->condition.center[0] = c;
    SDL_UpdateHapticEffect(dev.haptic, id, e);
}

static void apply_ffb(float cforce, float spring, float damper, float friction, float rumble, float center) {
    if (!dev.haptic) {
        /* Gamepad without haptic subsystem: use joystick rumble as a fallback. */
        if (dev.joy) {
            float r = clampf(fabsf(cforce) * 0.6f + rumble, 0, 1);
            SDL_RumbleJoystick(dev.joy, (Uint16)(r * 65535), (Uint16)(clampf(rumble, 0, 1) * 65535), 200);
        }
        return;
    }
    if (dev.eff_const >= 0) {
        Sint16 lvl = (Sint16)(clampf(cforce, -1, 1) * 32767.0f);
        if (lvl != dev.e_const.constant.level) {
            dev.e_const.constant.level = lvl;
            SDL_UpdateHapticEffect(dev.haptic, dev.eff_const, &dev.e_const);
        }
    }
    set_condition(dev.eff_spring, &dev.e_spring, spring, center);
    set_condition(dev.eff_damper, &dev.e_damper, damper, 0);
    set_condition(dev.eff_friction, &dev.e_friction, friction, 0);
    if (dev.eff_sine >= 0) {
        Sint16 mag = (Sint16)(clampf(rumble, 0, 1) * 32767.0f);
        if (mag != dev.e_sine.periodic.magnitude) {
            dev.e_sine.periodic.magnitude = mag;
            SDL_UpdateHapticEffect(dev.haptic, dev.eff_sine, &dev.e_sine);
        }
    } else if (dev.rumble_api) {
        Uint64 now = SDL_GetTicks();
        if (fabsf(rumble - dev.last_rumble) > 0.02f || now - dev.last_rumble_ms > 150) {
            if (rumble > 0.01f) SDL_PlayHapticRumble(dev.haptic, clampf(rumble, 0, 1), 250);
            else SDL_StopHapticRumble(dev.haptic);
            dev.last_rumble = rumble;
            dev.last_rumble_ms = now;
        }
    }
}

static void handle_cmd(char *line) {
    char *cmd = strtok(line, " ");
    if (!cmd) return;
    if (!strcmp(cmd, "list")) list_devices();
    else if (!strcmp(cmd, "open")) {
        char *a = strtok(NULL, " ");
        open_device(a ? (SDL_JoystickID)strtoul(a, NULL, 10) : 0);
    } else if (!strcmp(cmd, "ffb")) {
        float v[6] = {0, 0, 0, 0, 0, 0};
        for (int i = 0; i < 6; i++) { char *t = strtok(NULL, " "); if (t) v[i] = (float)atof(t); }
        apply_ffb(v[0], v[1], v[2], v[3], v[4], v[5]);
    } else if (!strcmp(cmd, "gain")) {
        char *a = strtok(NULL, " ");
        if (dev.haptic && (dev.features & SDL_HAPTIC_GAIN) && a) SDL_SetHapticGain(dev.haptic, atoi(a));
    } else if (!strcmp(cmd, "autocenter")) {
        char *a = strtok(NULL, " ");
        if (dev.haptic && (dev.features & SDL_HAPTIC_AUTOCENTER) && a) SDL_SetHapticAutocenter(dev.haptic, atoi(a));
    } else if (!strcmp(cmd, "stop")) {
        apply_ffb(0, 0, 0, 0, 0, 0);
    } else if (!strcmp(cmd, "rate")) {
        char *a = strtok(NULL, " ");
        if (a) { int hz = atoi(a); if (hz >= 10 && hz <= 1000) input_hz = hz; }
    } else if (!strcmp(cmd, "quit")) running = false;
    else out("error unknown command %s", cmd);
}

static void report_input(void) {
    if (!dev.joy) return;
    static char last[2048];
    char buf[2048];
    size_t j = 0;
    int na = SDL_GetNumJoystickAxes(dev.joy), nb = SDL_GetNumJoystickButtons(dev.joy), nh = SDL_GetNumJoystickHats(dev.joy);
    j += (size_t)snprintf(buf + j, sizeof buf - j, "input %u a:", (unsigned)dev.id);
    for (int i = 0; i < na && i < 16; i++)
        j += (size_t)snprintf(buf + j, sizeof buf - j, "%s%.4f", i ? "," : "", SDL_GetJoystickAxis(dev.joy, i) / 32767.0f);
    j += (size_t)snprintf(buf + j, sizeof buf - j, " b:");
    for (int i = 0; i < nb && i < 128; i++) buf[j++] = SDL_GetJoystickButton(dev.joy, i) ? '1' : '0';
    buf[j] = 0;
    j += (size_t)snprintf(buf + j, sizeof buf - j, " h:");
    for (int i = 0; i < nh && i < 4; i++)
        j += (size_t)snprintf(buf + j, sizeof buf - j, "%s%u", i ? "," : "", (unsigned)SDL_GetJoystickHat(dev.joy, i));
    if (strcmp(buf, last) != 0) {
        strcpy(last, buf);
        out("%s", buf);
    }
}

int main(int argc, char **argv) {
    (void)argc; (void)argv;
    SDL_SetHint(SDL_HINT_JOYSTICK_ALLOW_BACKGROUND_EVENTS, "1");
    SDL_SetHint(SDL_HINT_JOYSTICK_RAWINPUT, "0"); /* DirectInput path is required for FFB wheels */
    if (!SDL_Init(SDL_INIT_JOYSTICK | SDL_INIT_HAPTIC | SDL_INIT_EVENTS)) {
        out("error SDL_Init: %s", SDL_GetError());
        return 1;
    }
    memset(&dev, 0, sizeof dev);
    dev.eff_const = dev.eff_spring = dev.eff_damper = dev.eff_friction = dev.eff_sine = -1;
    cmd_lock = SDL_CreateMutex();
    int v = SDL_GetVersion();
    out("ready %d.%d.%d", SDL_VERSIONNUM_MAJOR(v), SDL_VERSIONNUM_MINOR(v), SDL_VERSIONNUM_MICRO(v));
    SDL_Thread *t = SDL_CreateThread(stdin_thread, "stdin", NULL);
    SDL_DetachThread(t);

    Uint64 last_input = 0;
    char cmd[256];
    while (running) {
        SDL_Event ev;
        while (SDL_PollEvent(&ev)) {
            if (ev.type == SDL_EVENT_JOYSTICK_ADDED || ev.type == SDL_EVENT_JOYSTICK_REMOVED) {
                if (ev.type == SDL_EVENT_JOYSTICK_REMOVED && dev.joy && ev.jdevice.which == dev.id) {
                    close_device();
                    out("log device removed");
                }
                list_devices();
            }
        }
        while (pop_cmd(cmd)) handle_cmd(cmd);
        Uint64 now = SDL_GetTicksNS();
        if (now - last_input >= 1000000000ull / (Uint64)input_hz) {
            SDL_UpdateJoysticks();
            report_input();
            last_input = now;
        }
        SDL_DelayNS(1000000); /* 1 ms */
    }
    close_device();
    SDL_Quit();
    return 0;
}
