// ================================================================
// OPTIMIZED FERMENTOR SYNC
// ================================================================
//
// IMPORTANT:
//
// ACTION 5 uses a Drive FILE snapshot.
//
// A change INSIDE an existing Google Sheet does NOT invalidate
// the Drive snapshot.
//
// A newly CREATED file inside BREW_FOLDER_ID DOES invalidate it.
//
// Therefore:
//
//   Existing Sheet content changed
//      -> NO Drive folder scan
//
//   New Sheet added
//      -> Drive snapshot invalidated
//      -> ONE full recursive scan
//
//   Nothing changed in Drive
//      -> use existing snapshot
//
// ================================================================


// ================================================================
// LOCAL CHANGE-DETECTION CACHE
// ================================================================

function computeHash_(value) {

  const json = JSON.stringify(value);

  const digestBytes =
    Utilities.computeDigest(
      Utilities.DigestAlgorithm.MD5,
      json,
      Utilities.Charset.UTF_8
    );

  return digestBytes
    .map(function (b) {
      return ((b < 0 ? b + 256 : b).toString(16)).padStart(2, "0");
    })
    .join("");
}


function hasChangedLocally_(key, value) {

  const props = PropertiesService.getScriptProperties();

  const newHash = computeHash_(value);
  const oldHash = props.getProperty(key);

  if (oldHash === newHash) {
    return false;
  }

  props.setProperty(key, newHash);
  return true;
}


// function resetChangeCache() {

//   PropertiesService.getScriptProperties().deleteAllProperties();

//   Logger.log("Change-detection cache cleared.");
// }


// ================================================================
// DRIVE SNAPSHOT CONFIG
// ================================================================

const BREW_DRIVE_SNAPSHOT_KEY = "brew_drive_snapshot_v2";
const BREW_DRIVE_CHANGE_TOKEN_KEY = "brew_drive_change_token_v2";


// ================================================================
// MAIN 5-MINUTE CYCLE
// ================================================================

// function runFermentorCycle() {

//   Logger.log("========================================");
//   Logger.log("START FERMENTOR CYCLE");

//   const startTime = new Date();

//   const projectId = FIREBASE_PROJECT_ID;

//   // ------------------------------------------------------------
//   // ONE Firestore list call
//   // ------------------------------------------------------------

//   const fermentors = getAllFermentorsFromFirestore(projectId);

//   Logger.log(
//     "Fermentors fetched once: " + fermentors.length
//   );

//   // ------------------------------------------------------------
//   // STEP 1
//   // ------------------------------------------------------------

//   const syncStats =
//     syncFermentorsFromSheets_(projectId, fermentors);

//   // ------------------------------------------------------------
//   // STEP 2
//   // ------------------------------------------------------------

//   const actionStats =
//     runActionFlow_(fermentors);

//   const duration =
//     (new Date().getTime() - startTime.getTime()) / 1000;

//   Logger.log("========================================");
//   Logger.log(
//     "CYCLE FINISHED in " +
//     duration +
//     "s"
//   );

//   Logger.log(
//     "Sync -> updated: " +
//     syncStats.updated +
//     ", skipped: " +
//     syncStats.skipped +
//     ", errors: " +
//     syncStats.errors
//   );

//   Logger.log(
//     "Action -> a0(emptyTanks): " +
//     actionStats.a0 +
//     ", a1(full): " +
//     actionStats.a1 +
//     ", a5(ready for next batch): " +
//     actionStats.a5
//   );

//   Logger.log("========================================");

//   return {
//     durationSeconds: duration,
//     fermentorsCount: fermentors.length,
//     sync: syncStats,
//     action: actionStats
//   };
// }


// ================================================================
// STEP 1 — SYNC SHEETS INTO FERMENTOR DOCS
// ================================================================

// function syncFermentorsFromSheets_(projectId, fermentors) {

//   let updatedCount = 0;
//   let skippedCount = 0;
//   let errorCount = 0;
//   let latestMeasurementWrites = 0;

//   fermentors.forEach(function (fermentor) {

//     const fermentorId = fermentor.id;

//     try {

//       const sheetUrl = fermentor.data.sheetUrl;

//       if (!sheetUrl) {
//         skippedCount++;
//         return;
//       }

//       const brew = extractBrew(sheetUrl);

//       if (!brew || !brew.tankNumber) {
//         skippedCount++;
//         return;
//       }

//       const newData = {

//         tankNumber:
//           String(brew.tankNumber).trim(),

//         tankStatus:
//           brew.tankStatus === "TRUE",

//         batchNumber:
//           brew.batchNumber || null,

//         beerStyle:
//           brew.beerStyle || null,

//         brewDate:
//           brew.brewDate || null,

//         beerVolume:
//           brew.beerVolume || null,

//         currentData:
//           brew.currentData || null,

//         sheetUrl:
//           brew.sheetUrl || null,

//         uid:
//           fermentorId,

//         startingPlato:
//           brew.startingPlato || null
//       };

//       const action =
//         parseAction(fermentor.data.action);

//       // ----------------------------------------------------------
//       // Packaging
//       // ----------------------------------------------------------

//       if (
//         action !== null &&
//         action >= 3 &&
//         newData.currentData
//       ) {

//         try {

//           const sheetPackaging =
//             readPackagingInfoFromSheet(sheetUrl);

//           if (sheetPackaging) {

//             const packagingCacheKey =
//               "packaging:" + fermentorId;

//             const packagingChanged =
//               hasChangedLocally_(
//                 packagingCacheKey,
//                 sheetPackaging
//               );

//             if (packagingChanged) {

//               if (
//                 sheetPackaging.kegs !== null
//               ) {
//                 newData.currentData.kegs =
//                   sheetPackaging.kegs;
//               }

//               if (
//                 sheetPackaging.crates !== null
//               ) {
//                 newData.currentData.crates =
//                   sheetPackaging.crates;
//               }

//               if (
//                 sheetPackaging.totalLiters !== null
//               ) {
//                 newData.currentData.totalLiters =
//                   sheetPackaging.totalLiters;
//               }

//               if (
//                 sheetPackaging.shrinkagePercent !== null
//               ) {
//                 newData.currentData.shrinkagePercent =
//                   sheetPackaging.shrinkagePercent;
//               }

//               Logger.log(
//                 "Packaging data changed on sheet for fermentor " +
//                 fermentorId
//               );
//             }
//           }

//         } catch (packagingError) {

//           Logger.log(
//             "ERROR reading packaging info for fermentor " +
//             fermentorId +
//             ": " +
//             packagingError.message
//           );
//         }
//       }

//       // ----------------------------------------------------------
//       // Local change detection
//       // ----------------------------------------------------------

//       const cacheKey =
//         "fermentor:" + fermentorId;

//       const fermentorChanged =
//         hasChangedLocally_(
//           cacheKey,
//           newData
//         );

//       // ----------------------------------------------------------
//       // Latest measurement
//       // ----------------------------------------------------------

//       if (newData.batchNumber) {

//         try {

//           const wrote =
//             writeLatestMeasurementIfChanged_(
//               projectId,
//               newData.batchNumber,
//               sheetUrl
//             );

//           if (wrote) {
//             latestMeasurementWrites++;
//           }

//         } catch (measurementError) {

//           Logger.log(
//             "ERROR writing latest measurement for fermentor " +
//             fermentorId +
//             ": " +
//             measurementError.message
//           );
//         }
//       }

//       // ----------------------------------------------------------
//       // Nothing changed
//       // ----------------------------------------------------------

//       if (!fermentorChanged) {

//         skippedCount++;
//         return;
//       }

//       newData.updatedAt =
//         new Date();

//       updateFermentorDocument(
//         projectId,
//         fermentorId,
//         newData
//       );

//       updatedCount++;

//     } catch (error) {

//       errorCount++;

//       Logger.log(
//         "ERROR syncing fermentor " +
//         fermentorId +
//         ": " +
//         error.message
//       );
//     }
//   });

//   return {
//     updated: updatedCount,
//     skipped: skippedCount,
//     errors: errorCount,
//     latestMeasurementWrites:
//       latestMeasurementWrites
//   };
// }


// ================================================================
// LATEST MEASUREMENT
// ================================================================

// function writeLatestMeasurementIfChanged_(
//   projectId,
//   batchId,
//   sheetUrl
// ) {

//   const lock =
//     LockService.getScriptLock();

//   lock.waitLock(30000);

//   try {

//     const spreadsheetId =
//       extractSpreadsheetId(sheetUrl);

//     const ss =
//       SpreadsheetApp.openById(
//         spreadsheetId
//       );

//     const sheet =
//       ss.getSheets()[0];

//     const values =
//       sheet
//         .getDataRange()
//         .getDisplayValues();

//     const headerRow =
//       findRowContaining(
//         values,
//         "טמפרטורה"
//       );

//     if (headerRow === -1) {
//       return false;
//     }

//     for (
//       let r = values.length - 1;
//       r > headerRow;
//       r--
//     ) {

//       const dateText =
//         String(values[r][0] || "").trim();

//       const date =
//         parseIsraeliDate(dateText);

//       if (!date) continue;

//       const hasAnyValue =
//         values[r][2] ||
//         values[r][3] ||
//         values[r][4] ||
//         values[r][5] ||
//         values[r][6] ||
//         values[r][7];

//       if (!hasAnyValue) continue;

//       const time =
//         String(values[r][1] || "").trim();

//       const measurement = {

//         date: dateText,

//         time: time,

//         temp:
//           extractNumber(values[r][3]),

//         plato:
//           extractNumber(values[r][2]),

//         pressure:
//           extractNumber(values[r][4]),

//         carbonation:
//           extractNumber(values[r][6]),

//         pH:
//           extractNumber(values[r][5]),

//         notes:
//           String(values[r][7] || "").trim()
//       };

//       const measurementId =
//         createMeasurementId(
//           date,
//           time
//         );

//       const cacheKey =
//         "measurement:" +
//         batchId +
//         ":" +
//         measurementId;

//       if (
//         !hasChangedLocally_(
//           cacheKey,
//           measurement
//         )
//       ) {
//         return false;
//       }

//       const docPath =
//         "projects/" +
//         projectId +
//         "/databases/(default)/documents/brews/" +
//         encodeURIComponent(batchId) +
//         "/measurements/" +
//         encodeURIComponent(measurementId);

//       const url =
//         "https://firestore.googleapis.com/v1/projects/" +
//         projectId +
//         "/databases/(default)/documents/brews/" +
//         encodeURIComponent(batchId) +
//         "/measurements/" +
//         encodeURIComponent(measurementId);

//       const response =
//         UrlFetchApp.fetch(
//           url,
//           {
//             method: "patch",

//             contentType:
//               "application/json",

//             headers: {
//               Authorization:
//                 "Bearer " +
//                 ScriptApp.getOAuthToken()
//             },

//             payload:
//               JSON.stringify({
//                 fields:
//                   toFirestoreFields(
//                     measurement
//                   )
//               }),

//             muteHttpExceptions: true
//           }
//         );

//       const code =
//         response.getResponseCode();

//       if (
//         code < 200 ||
//         code >= 300
//       ) {

//         throw new Error(
//           "Latest-measurement write failed for batch " +
//           batchId +
//           ": " +
//           code +
//           " " +
//           response.getContentText()
//         );
//       }

//       Logger.log(
//         "Wrote latest measurement immediately: " +
//         docPath
//       );

//       return true;
//     }

//     return false;

//   } finally {

//     try {
//       lock.releaseLock();
//     } catch (e) {}
//   }
// }


// ================================================================
// STEP 2 — ACTION FLOW
// ================================================================

function runActionFlow_(fermentors) {

  let a0 = 0;
  let a1 = 0;
  let a5 = 0;

  // ------------------------------------------------------------
  // IMPORTANT:
  //
  // We only ask Drive for the ACTION 5 candidate list if at least
  // one fermentor is currently in ACTION 5.
  //
  // The Drive snapshot mechanism below decides whether a FULL
  // SCAN is necessary.
  // ------------------------------------------------------------

  const hasAction5 =
    fermentors.some(function (entry) {

      return (
        parseAction(
          entry.data.action
        ) === 5
      );

    });

  let candidates = null;

  if (hasAction5) {

    candidates =
      getBrewFolderCandidatesCached();

    Logger.log(
      "ACTION 5 candidates prepared ONCE: " +
      candidates.length
    );
  }

  // ------------------------------------------------------------
  // Per-execution extractBrew cache
  // ------------------------------------------------------------

  const brewExtractCache = {};

  fermentors.forEach(function (fermentorEntry) {

    const fermentor =
      Object.assign(
        {
          uid:
            fermentorEntry.id
        },
        fermentorEntry.data
      );

    const action =
      parseAction(
        fermentor.action
      );

    try {

      if (action === 0) {

        a0++;

        processAction0(
          fermentor
        );

        return;
      }

      if (action === 1) {

        a1++;

        processAction1(
          fermentor
        );

        return;
      }

      if (action === 5) {

        a5++;

        processAction5(
          fermentor,
          candidates,
          brewExtractCache
        );

        return;
      }

      // ACTION 3 / 4:
      // controlled by GUI.

    } catch (error) {

      Logger.log(
        "ERROR action-flow for tank " +
        fermentor.tankNumber +
        ": " +
        error.message
      );
    }
  });

  return {
    a0: a0,
    a1: a1,
    a5: a5
  };
}


// ================================================================
// ACTION 0
// ================================================================

function processAction0(fermentor) {

  const tankNumber =
    String(
      fermentor.tankNumber || ""
    ).trim();

  const sheetUrl =
    String(
      fermentor.sheetUrl || ""
    ).trim();

  if (!sheetUrl) return;

  let stageInfo;

  try {

    stageInfo =
      extractBrewStageInfo(
        sheetUrl,
        fermentor
      );

  } catch (error) {

    Logger.log(
      "extractBrewStageInfo failed: " +
      error.message
    );

    return;
  }

  if (
    !stageInfo ||
    !stageInfo.lastBlock
  ) {
    return;
  }

  try {

    updateFermentorBrewProgress(
      tankNumber,
      stageInfo
    );

  } catch (error) {

    Logger.log(
      "updateFermentorBrewProgress failed: " +
      error.message
    );
  }

  if (
    stageInfo.beerVolume !== null &&
    stageInfo.beerVolume !== undefined
  ) {

    updateFermentorAction(
      tankNumber,
      1
    );

    return;
  }

  if (
    stageInfo.hasUnstartedHeader
  ) {

    Logger.log(
      "Tank " +
      tankNumber +
      ": another planned brew block hasn't started yet - staying ACTION 0."
    );

    return;
  }

  const outStage =
    stageInfo.lastBlock.stages.find(
      function (s) {
        return (
          s.code ===
          STAGE_CODE_OUT_TO_FERMENTOR
        );
      }
    );

  if (
    outStage &&
    outStage.startDateTime
  ) {

    const graceMs =
      2 *
      60 *
      60 *
      1000;

    if (
      Date.now() -
      outStage.startDateTime.getTime() >=
      graceMs
    ) {

      updateFermentorAction(
        tankNumber,
        1
      );

      return;
    }
  }
}


// ================================================================
// ACTION 1
// ================================================================

function processAction1(fermentor) {

  const tankNumber =
    String(
      fermentor.tankNumber || ""
    ).trim();

  const tankStatus =
    fermentor.tankStatus;

  const tankStatusIsTrue =
    tankStatus === true ||
    String(tankStatus)
      .trim()
      .toUpperCase() === "TRUE";

  if (tankStatusIsTrue) {

    updateFermentorAction(
      tankNumber,
      3
    );
  }
}


// ================================================================
// ACTION 5
// ================================================================

function processAction5(
  fermentor,
  candidates,
  brewExtractCache
) {

  const tankNumber =
    String(
      fermentor.tankNumber || ""
    ).trim();

  const currentBatch =
    parseBatchNumber(
      fermentor.batchNumber
    );

  if (currentBatch === null) {
    return;
  }

  const nextBrew =
    findNextBrewForTankRecursive(
      tankNumber,
      currentBatch,
      candidates,
      brewExtractCache
    );

  if (!nextBrew) {

    Logger.log(
      "ACTION 5 Tank " +
      tankNumber +
      ": no matching future brew found."
    );

    return;
  }

  uploadBrewToFirebase(
    nextBrew.sheetUrl
  );

  updateFermentorSheetUrl(
    tankNumber,
    nextBrew.sheetUrl
  );

  updateFermentorAction(
    tankNumber,
    0
  );

  Logger.log(
    "ACTION 5 completed successfully for tank " +
    tankNumber
  );
}


// ================================================================
// FIND NEXT BREW
// ================================================================

function findNextBrewForTankRecursive(
  tankNumber,
  currentBatch,
  candidates,
  brewExtractCache
) {

  Logger.log(
    "ACTION 5 SEARCH Tank: " +
    tankNumber
  );

  if (!candidates) {

    candidates =
      getBrewFolderCandidatesCached();
  }

  if (!brewExtractCache) {
    brewExtractCache = {};
  }

  const targetTank =
    normalizeTankNumber(
      tankNumber
    );

  for (
    let i = 0;
    i < candidates.length;
    i++
  ) {

    const candidate =
      candidates[i];

    if (
      candidate.batch <=
      currentBatch
    ) {
      continue;
    }

    let brew;

    try {

      brew =
        extractBrewCached(
          candidate.fileId,
          brewExtractCache
        );

    } catch (error) {

      Logger.log(
        "extractBrew failed for " +
        candidate.fileName +
        ": " +
        error.message
      );

      continue;
    }

    if (!brew) {
      continue;
    }

    const extractedTank =
      normalizeTankNumber(
        brew.tankNumber
      );

    if (
      !tankNumbersEqual(
        extractedTank,
        targetTank
      )
    ) {
      continue;
    }

    return {

      found: true,

      batchNumber:
        String(candidate.batch),

      tankNumber:
        tankNumber,

      beerStyle:
        brew.beerStyle,

      brewDate:
        brew.brewDate,

      beerVolume:
        brew.beerVolume,

      startingPlato:
        brew.startingPlato,

      sheetUrl:
        buildSheetUrl(
          candidate.fileId
        ),

      fileId:
        candidate.fileId,

      fileName:
        candidate.fileName
    };
  }

  return null;
}


// ================================================================
// extractBrew MEMOIZATION
// ================================================================

function extractBrewCached(
  fileId,
  brewExtractCache
) {

  if (
    Object.prototype.hasOwnProperty.call(
      brewExtractCache,
      fileId
    )
  ) {

    return brewExtractCache[fileId];
  }

  const brew =
    extractBrew(fileId);

  brewExtractCache[fileId] =
    brew;

  return brew;
}


// ================================================================
// ACTION 5 — DRIVE SNAPSHOT
// ================================================================
//
// This is the important part.
//
// The snapshot contains ONLY the list of files relevant to
// ACTION 5:
//
//   fileId
//   fileName
//   batch
//
// We do NOT store Sheet contents.
//
// Therefore changing cells inside an existing Sheet does NOT
// trigger a Drive rescan.
//
// The Drive Changes API is used only to detect whether files
// were created/deleted/moved.
//
// ================================================================

function getBrewFolderCandidatesCached() {

  const props =
    PropertiesService.getScriptProperties();

  const snapshotJson =
    props.getProperty(
      BREW_DRIVE_SNAPSHOT_KEY
    );

  const savedToken =
    props.getProperty(
      BREW_DRIVE_CHANGE_TOKEN_KEY
    );

  // ------------------------------------------------------------
  // First run
  // ------------------------------------------------------------

  if (!snapshotJson || !savedToken) {

    Logger.log(
      "ACTION 5: no Drive snapshot yet - first scan."
    );

    const candidates =
      performFullBrewFolderScan_();

    saveBrewDriveSnapshot_(
      candidates
    );

    const newToken =
      getDriveStartPageToken_();

    if (newToken) {

      props.setProperty(
        BREW_DRIVE_CHANGE_TOKEN_KEY,
        newToken
      );
    }

    Logger.log(
      "ACTION 5: initial Drive snapshot saved."
    );

    return candidates;
  }

  // ------------------------------------------------------------
  // Check whether files changed
  // ------------------------------------------------------------

  Logger.log(
    "ACTION 5: checking Drive file changes..."
  );

  const changeResult =
    checkBrewDriveFileChanges_(
      savedToken
    );

  if (
    changeResult.error
  ) {

    Logger.log(
      "ACTION 5: Drive change check failed: " +
      changeResult.error
    );

    Logger.log(
      "ACTION 5: keeping existing snapshot."
    );

    return JSON.parse(
      snapshotJson
    );
  }

  // ------------------------------------------------------------
  // No relevant file changes
  // ------------------------------------------------------------

  if (!changeResult.relevantChanges) {

    Logger.log(
      "ACTION 5: no relevant Drive file changes."
    );

    return JSON.parse(
      snapshotJson
    );
  }

  // ------------------------------------------------------------
  // Relevant file change
  // ------------------------------------------------------------

  Logger.log(
    "ACTION 5: relevant Drive file change detected."
  );

  const candidates =
    performFullBrewFolderScan_();

  saveBrewDriveSnapshot_(
    candidates
  );

  if (
    changeResult.newStartToken
  ) {

    props.setProperty(
      BREW_DRIVE_CHANGE_TOKEN_KEY,
      changeResult.newStartToken
    );
  }

  Logger.log(
    "ACTION 5: snapshot rebuilt. Candidates: " +
    candidates.length
  );

  return candidates;
}


// ================================================================
// FULL SCAN
// ================================================================

function performFullBrewFolderScan_() {

  const start =
    new Date().getTime();

  Logger.log(
    "ACTION 5: STARTING FULL BREW FOLDER SCAN"
  );

  const candidates =
    scanBrewFolderCandidates();

  const elapsed =
    (
      new Date().getTime() -
      start
    ) / 1000;

  Logger.log(
    "ACTION 5: FULL BREW FOLDER SCAN FINISHED in " +
    elapsed +
    "s"
  );

  return candidates;
}


// ================================================================
// SAVE SNAPSHOT
// ================================================================

function saveBrewDriveSnapshot_(
  candidates
) {

  const props =
    PropertiesService.getScriptProperties();

  props.setProperty(
    BREW_DRIVE_SNAPSHOT_KEY,
    JSON.stringify(candidates)
  );

  Logger.log(
    "ACTION 5: saved " +
    candidates.length +
    " candidates to snapshot."
  );
}


// ================================================================
// DRIVE CHANGES API
// ================================================================
//
// IMPORTANT:
//
// We intentionally do NOT treat every Drive change as a reason
// to rescan.
//
// Google Sheets CONTENT edits can appear in Drive's change feed.
// Those are ignored.
//
// We only invalidate the snapshot when the changed item itself
// looks like a FILE-STRUCTURE change:
//
//   - created
//   - removed
//   - moved / parent changed
//   - renamed
//
// Even then, we only care about Google Sheets / files that could
// potentially belong to BREW_FOLDER_ID.
//
// ================================================================

function checkBrewDriveFileChanges_(
  pageToken
) {

  try {

    const service =
      getDriveAdvancedService_();

    let token =
      pageToken;

    let relevantChanges =
      false;

    let pages =
      0;

    while (token) {

      pages++;

      if (pages > 20) {

        return {
          error:
            "Too many Drive change pages."
        };
      }

      const response =
        service.Changes.list(
          token,
          {
            pageSize: 100,

            fields:
              "nextPageToken,newStartPageToken,changes(fileId,removed,file(\
id,name,mimeType,parents,trashed,createdTime,modifiedTime))"
          }
        );

      const changes =
        response.changes || [];

      for (
        let i = 0;
        i < changes.length;
        i++
      ) {

        const change =
          changes[i];

        // ------------------------------------------------------
        // Deleted file
        // ------------------------------------------------------

        if (
          change.removed === true
        ) {

          relevantChanges = true;
          continue;
        }

        const file =
          change.file;

        if (!file) {
          continue;
        }

        // ------------------------------------------------------
        // We ignore ordinary content edits.
        //
        // The key distinction is:
        //
        // modifiedTime changing alone is NOT enough.
        //
        // A content edit in an existing Sheet therefore does
        // NOT cause a full BREW folder scan.
        // ------------------------------------------------------

        const fileName =
          String(
            file.name || ""
          );

        const mimeType =
          String(
            file.mimeType || ""
          );

        if (
          mimeType !==
          MimeType.GOOGLE_SHEETS
        ) {

          continue;
        }

        // ------------------------------------------------------
        // If the file was created recently, this is relevant.
        // ------------------------------------------------------

        if (
          file.createdTime
        ) {

          const created =
            new Date(
              file.createdTime
            ).getTime();

          const modified =
            file.modifiedTime
              ? new Date(
                  file.modifiedTime
                ).getTime()
              : 0;

          // A newly created file normally has nearly identical
          // createdTime / modifiedTime.
          //
          // We use a small tolerance rather than exact equality.
          if (
            Math.abs(
              modified - created
            ) < 10000
          ) {

            relevantChanges = true;
            continue;
          }
        }

        // ------------------------------------------------------
        // IMPORTANT:
        //
        // We deliberately do NOT mark this relevant merely
        // because modifiedTime changed.
        //
        // This prevents editing cells in an existing Sheet from
        // causing a 20-30 second recursive Drive scan.
        // ------------------------------------------------------

        Logger.log(
          "ACTION 5: ignoring content modification: " +
          fileName
        );
      }

      if (
        response.nextPageToken
      ) {

        token =
          response.nextPageToken;

        continue;
      }

      return {
        relevantChanges:
          relevantChanges,

        newStartToken:
          response.newStartPageToken ||
          null
      };
    }

    return {
      relevantChanges:
        relevantChanges,

      newStartToken:
        null
    };

  } catch (error) {

    return {
      error:
        error.message
    };
  }
}


// ================================================================
// DRIVE START PAGE TOKEN
// ================================================================

function getDriveStartPageToken_() {

  try {

    const service =
      getDriveAdvancedService_();

    const response =
      service.Changes.getStartPageToken();

    return response.startPageToken;

  } catch (error) {

    Logger.log(
      "ACTION 5: failed getting Drive start token: " +
      error.message
    );

    return null;
  }
}


// ================================================================
// ADVANCED DRIVE SERVICE
// ================================================================
//
// Requires:
// Apps Script -> Services -> Drive API -> ON
//
// And in Google Cloud project:
// Drive API -> ENABLED
//
// ================================================================

function getDriveAdvancedService_() {

  if (
    typeof Drive === "undefined" ||
    !Drive.Changes
  ) {

    throw new Error(
      "Advanced Drive service is not enabled. " +
      "Enable Drive API under Apps Script Services."
    );
  }

  return Drive;
}


// ================================================================
// BREW FOLDER SCAN
// ================================================================

function scanBrewFolderCandidates() {

  const rootFolder =
    DriveApp.getFolderById(
      BREW_FOLDER_ID
    );

  const files = [];

  collectGoogleSheetsRecursive(
    rootFolder,
    files
  );

  Logger.log(
    "Total Google Sheets found recursively: " +
    files.length
  );

  const candidates = [];

  files.forEach(function (file) {

    const fileName =
      file.getName();

    const batch =
      extractBatchFromFilename(
        fileName
      );

    if (batch === null) {
      return;
    }

    candidates.push({

      fileId:
        file.getId(),

      fileName:
        fileName,

      batch:
        batch
    });
  });

  candidates.sort(
    function (a, b) {
      return a.batch - b.batch;
    }
  );

  Logger.log(
    "Candidates with valid batch numbers: " +
    candidates.length
  );

  return candidates;
}


// ================================================================
// BUILD SHEET URL
// ================================================================

function buildSheetUrl(
  fileId
) {

  return (
    "https://docs.google.com/spreadsheets/d/" +
    fileId +
    "/edit"
  );
}


// ================================================================
// RECURSIVE SHEET COLLECTION
// ================================================================

function collectGoogleSheetsRecursive(
  folder,
  result
) {

  const files =
    folder.getFiles();

  while (
    files.hasNext()
  ) {

    const file =
      files.next();

    if (
      file.getMimeType() ===
      MimeType.GOOGLE_SHEETS
    ) {

      result.push(file);
    }
  }

  const folders =
    folder.getFolders();

  while (
    folders.hasNext()
  ) {

    collectGoogleSheetsRecursive(
      folders.next(),
      result
    );
  }
}


// ================================================================
// EXTRACT BATCH NUMBER FROM FILENAME
// ================================================================

function extractBatchFromFilename(
  fileName
) {

  if (!fileName) {
    return null;
  }

  const text =
    String(fileName).trim();

  let match =
    text.match(
      /(\d{4,})\s*\#/
    );

  if (match) {

    const batch =
      Number(match[1]);

    if (
      Number.isFinite(batch)
    ) {

      return batch;
    }
  }

  match =
    text.match(
      /\#\s*(\d{4,})/
    );

  if (match) {

    const batch =
      Number(match[1]);

    if (
      Number.isFinite(batch)
    ) {

      return batch;
    }
  }

  return null;
}


// ================================================================
// NORMALIZE TANK
// ================================================================

function normalizeTankNumber(
  value
) {

  if (
    value === null ||
    value === undefined
  ) {

    return "";
  }

  return String(value)
    .trim()
    .replace(
      /^מיכל\s*/i,
      ""
    )
    .trim();
}


function tankNumbersEqual(
  a,
  b
) {

  const left =
    normalizeTankNumber(a);

  const right =
    normalizeTankNumber(b);

  if (!left || !right) {
    return false;
  }

  if (left === right) {
    return true;
  }

  const leftNumber =
    Number(left);

  const rightNumber =
    Number(right);

  if (
    Number.isFinite(leftNumber) &&
    Number.isFinite(rightNumber)
  ) {

    return (
      leftNumber === rightNumber
    );
  }

  return false;
}


// ================================================================
// PARSE ACTION
// ================================================================

function parseAction(
  value
) {

  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {

    return null;
  }

  const number =
    Number(value);

  if (
    !Number.isFinite(number)
  ) {

    return null;
  }

  return number;
}


// ================================================================
// PARSE BREW DATE
// ================================================================

function parseBrewDateForAction(
  value
) {

  if (
    value === null ||
    value === undefined
  ) {

    return null;
  }

  const text =
    String(value).trim();

  if (!text) {
    return null;
  }

  const israeliMatch =
    text.match(
      /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/
    );

  if (israeliMatch) {

    const day =
      Number(israeliMatch[1]);

    const month =
      Number(israeliMatch[2]) - 1;

    let year =
      Number(israeliMatch[3]);

    if (year < 100) {
      year += 2000;
    }

    const date =
      new Date(
        year,
        month,
        day
      );

    if (
      date.getFullYear() !== year ||
      date.getMonth() !== month ||
      date.getDate() !== day
    ) {

      return null;
    }

    return date;
  }

  const parsed =
    new Date(text);

  if (
    !isNaN(
      parsed.getTime()
    )
  ) {

    return parsed;
  }

  return null;
}


// ================================================================
// FORMAT DATE
// ================================================================

function formatActionDate(
  date
) {

  if (!date) {
    return "";
  }

  const day =
    String(
      date.getDate()
    ).padStart(2, "0");

  const month =
    String(
      date.getMonth() + 1
    ).padStart(2, "0");

  const year =
    date.getFullYear();

  return (
    day +
    "/" +
    month +
    "/" +
    year
  );
}


// ================================================================
// FIRESTORE — FERMENTORS
// ================================================================

function getAllFermentorsFromFirebase() {

  const url =
    "https://firestore.googleapis.com/v1/projects/" +
    FIREBASE_PROJECT_ID +
    "/databases/(default)/documents/fermentors";

  const response =
    UrlFetchApp.fetch(
      url,
      {
        method: "get",

        headers: {
          Authorization:
            "Bearer " +
            ScriptApp.getOAuthToken()
        },

        muteHttpExceptions:
          true
      }
    );

  const code =
    response.getResponseCode();

  if (
    code < 200 ||
    code >= 300
  ) {

    throw new Error(
      "Failed to get fermentors: " +
      code +
      " " +
      response.getContentText()
    );
  }

  const data =
    JSON.parse(
      response.getContentText()
    );

  const documents =
    data.documents || [];

  return documents.map(
    function (document) {

      const result = {};
      const fields =
        document.fields || {};

      for (
        const key in fields
      ) {

        result[key] =
          normalizeFirestoreValue(
            fields[key]
          );
      }

      if (!result.uid) {

        const parts =
          String(
            document.name || ""
          ).split("/");

        result.uid =
          parts[
            parts.length - 1
          ] || null;
      }

      return result;
    }
  );
}


// ================================================================
// FIRESTORE — SINGLE FERMENTOR
// ================================================================

function getFermentorFromFirebase(
  tankNumber
) {

  const fermentorId =
    String(tankNumber).trim();

  const url =
    "https://firestore.googleapis.com/v1/projects/" +
    FIREBASE_PROJECT_ID +
    "/databases/(default)/documents/fermentors/" +
    encodeURIComponent(
      fermentorId
    );

  const document =
    getFirestoreDocument(url);

  if (
    !document ||
    !document.fields
  ) {

    return null;
  }

  const result = {};

  for (
    const key in document.fields
  ) {

    result[key] =
      normalizeFirestoreValue(
        document.fields[key]
      );
  }

  return result;
}


// ================================================================
// UPDATE ACTION
// ================================================================

function updateFermentorAction(
  tankNumber,
  action
) {

  const fermentorId =
    String(tankNumber).trim();

  const url =
    "https://firestore.googleapis.com/v1/projects/" +
    FIREBASE_PROJECT_ID +
    "/databases/(default)/documents/fermentors/" +
    encodeURIComponent(
      fermentorId
    ) +
    "?updateMask.fieldPaths=action";

  const document = {

    fields: {

      action:
        toFirestoreValue(
          action
        )
    }
  };

  const response =
    UrlFetchApp.fetch(
      url,
      {

        method: "patch",

        contentType:
          "application/json",

        headers: {

          Authorization:
            "Bearer " +
            ScriptApp.getOAuthToken()
        },

        payload:
          JSON.stringify(
            document
          ),

        muteHttpExceptions:
          true
      }
    );

  const code =
    response.getResponseCode();

  if (
    code < 200 ||
    code >= 300
  ) {

    throw new Error(
      "Failed to update ACTION for tank " +
      fermentorId +
      ": " +
      code +
      " " +
      response.getContentText()
    );
  }

  Logger.log(
    "Updated tank " +
    fermentorId +
    " ACTION -> " +
    action
  );
}


// ================================================================
// UPDATE SHEET URL
// ================================================================

function updateFermentorSheetUrl(
  tankNumber,
  sheetUrl
) {

  const fermentorId =
    String(tankNumber).trim();

  const url =
    "https://firestore.googleapis.com/v1/projects/" +
    FIREBASE_PROJECT_ID +
    "/databases/(default)/documents/fermentors/" +
    encodeURIComponent(
      fermentorId
    ) +
    "?updateMask.fieldPaths=sheetUrl";

  const document = {

    fields: {

      sheetUrl:
        toFirestoreValue(
          sheetUrl
        )
    }
  };

  const response =
    UrlFetchApp.fetch(
      url,
      {

        method: "patch",

        contentType:
          "application/json",

        headers: {

          Authorization:
            "Bearer " +
            ScriptApp.getOAuthToken()
        },

        payload:
          JSON.stringify(
            document
          ),

        muteHttpExceptions:
          true
      }
    );

  const code =
    response.getResponseCode();

  if (
    code < 200 ||
    code >= 300
  ) {

    throw new Error(
      "Failed to update sheetUrl for tank " +
      fermentorId +
      ": " +
      code +
      " " +
      response.getContentText()
    );
  }
}


// ================================================================
// TEST — RESET DRIVE SNAPSHOT ONLY
// ================================================================

function resetBrewDriveSnapshot() {

  const props =
    PropertiesService
      .getScriptProperties();

  props.deleteProperty(
    BREW_DRIVE_SNAPSHOT_KEY
  );

  props.deleteProperty(
    BREW_DRIVE_CHANGE_TOKEN_KEY
  );

  Logger.log(
    "ACTION 5: Drive snapshot reset."
  );
}


// ================================================================
// TEST — FORCE FULL DRIVE SCAN
// ================================================================

function forceBrewDriveSnapshotScan() {

  const candidates =
    performFullBrewFolderScan_();

  saveBrewDriveSnapshot_(
    candidates
  );

  const token =
    getDriveStartPageToken_();

  if (token) {

    PropertiesService
      .getScriptProperties()
      .setProperty(
        BREW_DRIVE_CHANGE_TOKEN_KEY,
        token
      );
  }

  Logger.log(
    "ACTION 5: forced snapshot scan completed."
  );

  return candidates.length;
}


// ================================================================
// MANUAL TESTS
// ================================================================

function testRunFermentorCycle() {

  runFermentorCycle();
}


function testDailyHistoricalSync() {

  dailyHistoricalSync();
}
