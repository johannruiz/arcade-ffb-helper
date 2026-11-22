/* SDL3 wheel and its force feedback effects (the effect set of the former Arcade Launcher bridge). */
#include "ffb_device.h"
#include <string.h>
#include <stdio.h>
#include <math.h>

static float clampf(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }

void json_escape(const char *s, char *dst, size_t cap) {
    size_t j = 0;
    for (; s && *s && j + 2 < cap; s++) {
        if (*s == '"' || *s == '\\') dst[j++] = '\\';
        dst[j++] = ((unsigned char)*s < 0x20) ? ' ' : *s;
    }
    dst[j] = 0;
}

void ffb_features_json(Uint32 f, char *buf, size_t cap) {
    static const struct { Uint32 bit; const char *name; } map[] = {
        {SDL_HAPTIC_CONSTANT, "constant"}, {SDL_HAPTIC_SINE, "sine"},
        {SDL_HAPTIC_SPRING, "spring"},     {SDL_HAPTIC_DAMPER, "damper"},
        {SDL_HAPTIC_FRICTION, "friction"}, {SDL_HAPTIC_LEFTRIGHT, "leftright"},
        {SDL_HAPTIC_GAIN, "gain"},         {SDL_HAPTIC_AUTOCENTER, "autocenter"},
    };
    size_t j = 0;
    j += (size_t)snprintf(buf + j, cap - j, "[");
    bool first = true;
    for (size_t i = 0; i < sizeof map / sizeof map[0] && j < cap; i++) {
        if (f & map[i].bit) {
            j += (size_t)snprintf(buf + j, cap - j, "%s\"%s\"", first ? "" : ",", map[i].name);
            first = false;
        }
    }
    if (j < cap) snprintf(buf + j, cap - j, "]");
}

void ffb_init(FfbDevice *d) {
    memset(d, 0, sizeof *d);
    d->eff_const = d->eff_spring = d->eff_damper = d->eff_friction = d->eff_sine = -1;
}

int ffb_list(FfbDevice *d, FfbDeviceInfo *out, int cap) {
    int count = 0, n = 0;
    SDL_JoystickID *ids = SDL_GetJoysticks(&count);
    for (int i = 0; i < count && n < cap; i++) {
        SDL_JoystickID id = ids[i];
        bool mine = d->joy && d->id == id;
        SDL_Joystick *js = mine ? d->joy : SDL_OpenJoystick(id);
        if (!js) continue;
        FfbDeviceInfo *o = &out[n++];
        memset(o, 0, sizeof *o);
        o->id = id;
        SDL_strlcpy(o->name, SDL_GetJoystickName(js) ? SDL_GetJoystickName(js) : "?", sizeof o->name);
        o->vendor = SDL_GetJoystickVendor(js);
        o->product = SDL_GetJoystickProduct(js);
        o->haptic = SDL_IsJoystickHaptic(js);
        if (o->haptic) {
            if (mine && d->haptic) o->features = d->features;
            else {
                SDL_Haptic *h = SDL_OpenHapticFromJoystick(js);
                if (h) { o->features = SDL_GetHapticFeatures(h); SDL_CloseHaptic(h); }
            }
        }
        if (!mine) SDL_CloseJoystick(js);
    }
    SDL_free(ids);
    return n;
}

void ffb_close(FfbDevice *d) {
    if (d->haptic) {
        SDL_StopHapticEffects(d->haptic);
        SDL_CloseHaptic(d->haptic);
    }
    if (d->joy) SDL_CloseJoystick(d->joy);
    ffb_init(d);
}

/* An update that fails (device lost, driver refusing): counted, and logged the first times. */
static void update_effect(FfbDevice *d, int id, const SDL_HapticEffect *e) {
    if (SDL_UpdateHapticEffect(d->haptic, id, e)) return;
    d->update_errors++;
    if (d->update_errors <= 5 || d->update_errors % 1000 == 0)
        SDL_Log("effect type %u update failed (%u so far): %s", (unsigned)e->type, (unsigned)d->update_errors, SDL_GetError());
}

static int make_effect(FfbDevice *d, SDL_HapticEffect *e) {
    if (!SDL_HapticEffectSupported(d->haptic, e)) return -1;
    int id = SDL_CreateHapticEffect(d->haptic, e);
    if (id < 0) { SDL_Log("effect type %u create failed: %s", (unsigned)e->type, SDL_GetError()); return -1; }
    if (!SDL_RunHapticEffect(d->haptic, id, SDL_HAPTIC_INFINITY))
        SDL_Log("effect type %u run failed: %s", (unsigned)e->type, SDL_GetError());
    return id;
}

static void setup_effects(FfbDevice *d) {
    SDL_HapticDirection dir;
    memset(&dir, 0, sizeof dir);
    dir.type = SDL_HAPTIC_STEERING_AXIS;
    dir.dir[0] = 1;
    /* Some drivers reject STEERING_AXIS; fall back to cartesian X. */
    SDL_HapticEffect probe;
    memset(&probe, 0, sizeof probe);
    probe.type = SDL_HAPTIC_CONSTANT;
    probe.constant.direction = dir;
    probe.constant.length = SDL_HAPTIC_INFINITY;
    if ((d->features & SDL_HAPTIC_CONSTANT) && !SDL_HapticEffectSupported(d->haptic, &probe)) {
        memset(&dir, 0, sizeof dir);
        dir.type = SDL_HAPTIC_CARTESIAN;
        dir.dir[0] = 1;
    }
    if (d->features & SDL_HAPTIC_CONSTANT) {
        memset(&d->e_const, 0, sizeof d->e_const);
        d->e_const.type = SDL_HAPTIC_CONSTANT;
        d->e_const.constant.direction = dir;
        d->e_const.constant.length = SDL_HAPTIC_INFINITY;
        d->eff_const = make_effect(d, &d->e_const);
    }
    SDL_HapticEffectType types[3] = {SDL_HAPTIC_SPRING, SDL_HAPTIC_DAMPER, SDL_HAPTIC_FRICTION};
    SDL_HapticEffect *effs[3] = {&d->e_spring, &d->e_damper, &d->e_friction};
    int *ids[3] = {&d->eff_spring, &d->eff_damper, &d->eff_friction};
    for (int i = 0; i < 3; i++) {
        if (!(d->features & types[i])) continue;
        SDL_HapticEffect *e = effs[i];
        memset(e, 0, sizeof *e);
        e->type = types[i];
        e->condition.direction = dir;
        e->condition.length = SDL_HAPTIC_INFINITY;
        e->condition.right_sat[0] = e->condition.left_sat[0] = 0xFFFF;
        *ids[i] = make_effect(d, e);
    }
    if (d->features & SDL_HAPTIC_SINE) {
        memset(&d->e_sine, 0, sizeof d->e_sine);
        d->e_sine.type = SDL_HAPTIC_SINE;
        d->e_sine.periodic.direction = dir;
        d->e_sine.periodic.length = SDL_HAPTIC_INFINITY;
        d->e_sine.periodic.period = 40; /* 25 Hz road buzz */
        d->eff_sine = make_effect(d, &d->e_sine);
    }
    if (d->eff_sine < 0 && SDL_HapticRumbleSupported(d->haptic)) d->rumble_api = SDL_InitHapticRumble(d->haptic);
}

static SDL_JoystickID pick_device(const char *want_name) {
    int count = 0;
    SDL_JoystickID *ids = SDL_GetJoysticks(&count);
    SDL_JoystickID pick = 0;
    if (want_name && *want_name) {
        for (int i = 0; i < count && !pick; i++) {
            const char *n = SDL_GetJoystickNameForID(ids[i]);
            if (n && !strcmp(n, want_name)) pick = ids[i];
        }
    }
    /* pass 0: a wheel (constant force); pass 1: any haptic device */
    for (int pass = 0; pass < 2 && !pick; pass++) {
        for (int i = 0; i < count && !pick; i++) {
            SDL_Joystick *js = SDL_OpenJoystick(ids[i]);
            if (!js) continue;
            if (SDL_IsJoystickHaptic(js)) {
                SDL_Haptic *h = SDL_OpenHapticFromJoystick(js);
                Uint32 f = h ? SDL_GetHapticFeatures(h) : 0;
                if (h) SDL_CloseHaptic(h);
                if (pass == 1 || (f & SDL_HAPTIC_CONSTANT)) pick = ids[i];
            }
            SDL_CloseJoystick(js);
        }
    }
    SDL_free(ids);
    return pick;
}

bool ffb_open(FfbDevice *d, const char *want_name) {
    ffb_close(d);
    SDL_JoystickID pick = pick_device(want_name);
    if (!pick) return false;
    d->joy = SDL_OpenJoystick(pick);
    if (!d->joy) { SDL_Log("open joystick: %s", SDL_GetError()); return false; }
    d->id = pick;
    SDL_strlcpy(d->name, SDL_GetJoystickName(d->joy) ? SDL_GetJoystickName(d->joy) : "?", sizeof d->name);
    if (SDL_IsJoystickHaptic(d->joy)) {
        d->haptic = SDL_OpenHapticFromJoystick(d->joy);
        if (d->haptic) {
            d->features = SDL_GetHapticFeatures(d->haptic);
            if (d->features & SDL_HAPTIC_AUTOCENTER) SDL_SetHapticAutocenter(d->haptic, 0);
            if (d->features & SDL_HAPTIC_GAIN) SDL_SetHapticGain(d->haptic, 100);
            setup_effects(d);
        } else SDL_Log("haptic open failed: %s", SDL_GetError());
    }
    char fj[256];
    ffb_features_json(d->features, fj, sizeof fj);
    SDL_Log("opened %s [%04x:%04x] haptic=%d features=%s effects: constant=%d spring=%d damper=%d friction=%d sine=%d rumble=%d",
            d->name, SDL_GetJoystickVendor(d->joy), SDL_GetJoystickProduct(d->joy), d->haptic != NULL, fj,
            d->eff_const >= 0, d->eff_spring >= 0, d->eff_damper >= 0, d->eff_friction >= 0, d->eff_sine >= 0, d->rumble_api);
    return true;
}

bool ffb_has_wheel(const FfbDevice *d) {
    return d->haptic && (d->eff_const >= 0 || d->eff_spring >= 0 || d->eff_damper >= 0 || d->eff_friction >= 0 || d->eff_sine >= 0);
}

void ffb_set_gain(FfbDevice *d, int g) {
    if (d->haptic && (d->features & SDL_HAPTIC_GAIN)) SDL_SetHapticGain(d->haptic, g < 0 ? 0 : g > 100 ? 100 : g);
}

static void set_condition(FfbDevice *d, int id, SDL_HapticEffect *e, float strength) {
    if (id < 0) return;
    Sint16 coeff = (Sint16)(clampf(strength, 0, 1) * 32767.0f);
    if (e->condition.right_coeff[0] == coeff) return;
    e->condition.right_coeff[0] = e->condition.left_coeff[0] = coeff;
    update_effect(d, id, e);
}

void ffb_apply(FfbDevice *d, float constant, float spring, float damper, float friction, float rumble) {
    if (!ffb_has_wheel(d)) return; /* a plain gamepad keeps the game's own vibration */
    if (d->eff_const >= 0) {
        Sint16 lvl = (Sint16)(clampf(constant, -1, 1) * 32767.0f);
        if (lvl != d->e_const.constant.level) {
            d->e_const.constant.level = lvl;
            update_effect(d, d->eff_const, &d->e_const);
        }
    }
    set_condition(d, d->eff_spring, &d->e_spring, spring);
    set_condition(d, d->eff_damper, &d->e_damper, damper);
    set_condition(d, d->eff_friction, &d->e_friction, friction);
    if (d->eff_sine >= 0) {
        Sint16 mag = (Sint16)(clampf(rumble, 0, 1) * 32767.0f);
        if (mag != d->e_sine.periodic.magnitude) {
            d->e_sine.periodic.magnitude = mag;
            update_effect(d, d->eff_sine, &d->e_sine);
        }
    } else if (d->rumble_api) {
        Uint64 now = SDL_GetTicks();
        if (fabsf(rumble - d->last_rumble) > 0.02f || now - d->last_rumble_ms > 150) {
            if (rumble > 0.01f) SDL_PlayHapticRumble(d->haptic, clampf(rumble, 0, 1), 250);
            else SDL_StopHapticRumble(d->haptic);
            d->last_rumble = rumble;
            d->last_rumble_ms = now;
        }
    }
}
