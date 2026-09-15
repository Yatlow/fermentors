// ============================================================
// PACKAGING CACHE MAINTENANCE
// ============================================================
//
// Production entry point: clearPackagingCache
//
// readPackagingInfoFromSheet() itself is owned by
// fermentor-cycle-optimization.js so the 5-minute cycle can reuse its
// per-execution Sheet snapshot. Keeping it here as well would create another
// Apps Script global collision.
// ============================================================

function clearPackagingCache() {
  const props = PropertiesService.getScriptProperties();
  const allProps = props.getProperties();

  const keysToDelete = Object.keys(allProps)
    .filter(function (key) {
      return key.indexOf("packaging:") === 0;
    });

  keysToDelete.forEach(function (key) {
    props.deleteProperty(key);
  });

  Logger.log(
    "Cleared packaging cache. Deleted " +
    keysToDelete.length +
    " key(s)."
  );

  return {
    deletedCount: keysToDelete.length,
    deletedKeys: keysToDelete
  };
}
