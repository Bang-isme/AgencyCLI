/**
 * Secret-on-persist policy toggle.
 *
 * The memory package can't import the core runtime flags (that would create a
 * core → memory → core cycle), so the host (core bootstrap) flips this switch
 * from `flags.secretScan` at startup. Off by default → legacy behaviour (store
 * content verbatim). When on, `addEpisode` redacts detected secrets and
 * `insertVector` quarantines vectors whose content carries a credential.
 */
let secretScanEnabled = false;

export function setSecretScanEnabled(on: boolean): void {
  secretScanEnabled = on;
}

export function isSecretScanEnabled(): boolean {
  return secretScanEnabled;
}
