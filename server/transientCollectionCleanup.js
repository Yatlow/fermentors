// Short-lived Firestore workflow data retention. Called from maintenance.
const TRANSIENT_RETENTION_ = {
  brewSheetCreationJobs: { days: 30, terminalField: "state", terminalValues: ["ready"] },
  coolerUndoHistory: { days: 30 },
  ignoredCellarRecommendations: { days: 30 },
  scheduledCellarRecommendations: { days: 90, terminalField: "status", terminalValues: ["completed", "cancelled"] }
};
const TRANSIENT_CLEANUP_LIMIT_ = 50;
function cleanupTransientCollections_(){
  const props=PropertiesService.getScriptProperties();
  const today=Utilities.formatDate(new Date(),"Asia/Jerusalem","yyyy-MM-dd");
  if(props.getProperty("transient_cleanup_day_v1")===today)return {skipped:true,deleted:0};
  const token=ScriptApp.getOAuthToken(); let deleted=0;
  Object.keys(TRANSIENT_RETENTION_).forEach(function(collection){
    const policy=TRANSIENT_RETENTION_[collection]; const cutoff=new Date(Date.now()-policy.days*86400000).toISOString();
    const response=UrlFetchApp.fetch(packagingCleanupBaseUrl_()+":runQuery",{method:"post",contentType:"application/json",headers:{Authorization:"Bearer "+token},payload:JSON.stringify({structuredQuery:{from:[{collectionId:collection}],limit:TRANSIENT_CLEANUP_LIMIT_}}),muteHttpExceptions:true});
    if(response.getResponseCode()<200||response.getResponseCode()>=300)return;
    (JSON.parse(response.getContentText()||"[]")||[]).map(function(r){return r.document}).filter(Boolean).forEach(function(doc){
      const f=doc.fields||{}; const terminal=!policy.terminalField||policy.terminalValues.indexOf(String(normalizeFirestoreValue(f[policy.terminalField])||""))>=0;
      const stamp=String(normalizeFirestoreValue(f.resolvedAt||f.updatedAt||f.ignoredAt||f.createdAt)||"");
      if(!terminal||!stamp||stamp>cutoff)return;
      const id=String(doc.name||"").split("/").pop(); if(!id)return;
      const del=UrlFetchApp.fetch(packagingCleanupBaseUrl_()+"/"+collection+"/"+encodeURIComponent(id),{method:"delete",headers:{Authorization:"Bearer "+token},muteHttpExceptions:true});
      if(del.getResponseCode()===404||(del.getResponseCode()>=200&&del.getResponseCode()<300))deleted++;
    });
  });
  props.setProperty("transient_cleanup_day_v1",today); if(deleted)console.log("Transient cleanup deleted "+deleted+" records"); return {skipped:false,deleted:deleted};
}
