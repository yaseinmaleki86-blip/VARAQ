'use strict';
// Offline indexing-readiness audit; makes no claim of Google rankings/indexation.
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const seo=require('../lib/seo');
const storage=path.resolve(process.env.DATA_DIR||path.join(__dirname,'..','storage'));
const db=new DatabaseSync(path.join(storage,'varaq.sqlite'),{readOnly:true});
try {
 const count=sql=>db.prepare(sql).get().n;
 const total=count('SELECT COUNT(*) n FROM books');
 const authored=count("SELECT COUNT(*) n FROM books WHERE trim(author)<>''");
 const described=count("SELECT COUNT(*) n FROM books WHERE length(trim(description))>=120");
 const referenced=seo.approvedBooks(db).length;
 const titleOnly=total-referenced;
 const rights=count('SELECT COUNT(*) n FROM edition_sources WHERE rights_confirmed=1');
 console.log(JSON.stringify({version:'3.8.0',books:total,withAuthor:authored,withDescription120Chars:described,withReferencedVerifiedEditionAndAuthor:referenced,needsBibliographyBeforeIndexing:titleOnly,editionSourcesWithRightsConfirmed:rights,notes:['Sitemap in public mode limits book entries to sourced, verified, attributed pages.','These numbers are SEO preflight only, not a Google crawl or legal rights review.']},null,2));
} finally {db.close();}
