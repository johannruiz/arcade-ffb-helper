#pragma once
/* Self-update from GitHub Releases (johannruiz/arcade-ffb-helper, latest release).
 *
 * A background thread asks GitHub for the latest release when the helper starts and once a day.
 * When it is newer, it downloads this platform's file (Windows: ArcadeFFBHelper.exe, macOS: the
 * app's zip), checks it against the SHA-256 GitHub publishes for it and keeps it beside the
 * running copy. The main loop then installs it when no race is running: the running file is
 * moved aside, the new one takes its place, and the new version is started.
 *
 * Kept deliberately plain so antivirus heuristics have nothing to object to: no scripts, no
 * PowerShell, no hidden processes, no registry or startup entries, one fixed download source. */
#include <stdbool.h>
#include <stddef.h>

typedef enum {
    UPD_OFF,          /* turned off in the settings, or this build cannot update itself */
    UPD_WAITING,      /* before the first check */
    UPD_CHECKING,
    UPD_LATEST,       /* this is the latest version */
    UPD_DOWNLOADING,
    UPD_READY,        /* downloaded and verified: installs when no race is running */
    UPD_FAILED,       /* see the message; tried again at the next check */
} UpdState;

/* `current`: this version ("0.2.0"). `work_dir`: the settings folder (ends with a separator).
 * `installed_tag`: from --updated, the release this process was started as (or NULL). */
void updater_start(const char *current, const char *work_dir, const char *installed_tag, bool enabled);
void updater_enable(bool on);
UpdState updater_status(char *latest, size_t lcap, char *msg, size_t mcap);
const char *updater_state_name(UpdState s);
/* With UPD_READY: put the new version in place of this one. On success the caller releases the
 * wheel and the port, then calls updater_relaunch() and exits. */
bool updater_install(void);
bool updater_relaunch(void);
