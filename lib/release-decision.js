'use strict';
// Consolidated evidence: never equate automated checks with a legal or commercial launch approval.
function decide({source,backup,audit,smoke=null}={}){
 const blockers=[];
 if(!source?.passed)blockers.push('Static release files failed integrity verification.');
 if(!backup?.passed)blockers.push('No verified backup recovery rehearsal.');
 if(!audit?.readyForInformationPreview){
  for(const x of audit?.checks||[])if(x.scope==='preview'&&!x.ok)blockers.push('Preview: '+x.id+' — '+x.detail);
  if(!audit)blockers.push('Database readiness audit not completed.');
 }
 if(!smoke?.passed)blockers.push('Live public-readonly HTTP safety test not passed or not supplied.');
 if(audit?.paymentEnabled!==false||audit?.readyForPublicSales===true)blockers.push('Unexpected paid-sales status; manual review required.');
 return {
  version:'8.6.0',generatedAt:new Date().toISOString(),
  checks:{sourceVerified:Boolean(source?.passed),recoveryRehearsed:Boolean(backup?.passed),
   databasePreviewRequirements:Boolean(audit?.readyForInformationPreview),liveHttpPassed:Boolean(smoke?.passed)},
  technicalPreviewCandidate:blockers.length===0,
  publicPreviewApproved:false, // Human review is never granted by this script.
  commercialSalesApproved:false,
  browserVisualQaPerformed:false,
  note:'This local report does not prove browser/device QA, publisher permissions, legal compliance, live HTTPS deployment, or payment settlement.',
  blockers,
 };
}
module.exports={decide};
