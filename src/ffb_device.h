/* SDL3 wheel: device listing, opening and the force feedback effects. */
#pragma once
#include <SDL3/SDL.h>

typedef struct {
    SDL_JoystickID id;
    char name[128];
    Uint16 vendor, product;
    bool haptic;
    Uint32 features;
} FfbDeviceInfo;

typedef struct {
    SDL_Joystick *joy;
    SDL_Haptic *haptic;
    SDL_JoystickID id;
    char name[128];
    Uint32 features;
    int eff_const, eff_spring, eff_damper, eff_friction, eff_sine;
    SDL_HapticEffect e_const, e_spring, e_damper, e_friction, e_sine;
    bool rumble_api;
    float last_rumble;
    Uint64 last_rumble_ms;
    Uint32 update_errors;   /* SDL_UpdateHapticEffect failures since the device was opened */
} FfbDevice;

void ffb_init(FfbDevice *d);
/* Fills up to `cap` entries, returns the number of joysticks. */
int ffb_list(FfbDevice *d, FfbDeviceInfo *out, int cap);
/* Opens the joystick named `want_name` (exact); empty or not found: the first wheel with
 * constant force, then any haptic device. Returns true when a device is open. */
bool ffb_open(FfbDevice *d, const char *want_name);
void ffb_close(FfbDevice *d);
/* A device with wheel effects (not a plain gamepad). */
bool ffb_has_wheel(const FfbDevice *d);
void ffb_set_gain(FfbDevice *d, int gain_0_100);
/* constant -1..1 (+ = right), spring/damper/friction/rumble 0..1 */
void ffb_apply(FfbDevice *d, float constant, float spring, float damper, float friction, float rumble);
void ffb_features_json(Uint32 f, char *buf, size_t cap);
void json_escape(const char *s, char *dst, size_t cap);
