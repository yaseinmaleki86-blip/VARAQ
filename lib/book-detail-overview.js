'use strict';
// VARAQ 7.2: informational, deliberately not a checkout/availability guarantee.
function overview({editions=[], offers=[], digital=[], selectedEdition=null}={}){
 const relevant=selectedEdition ? offers.filter(o=>Number(o.edition_id)===Number(selectedEdition.id)) : offers;
 const eligible=relevant.filter(o=>Number.isSafeInteger(Number(o.price)) && Number(o.price)>0 && Number(o.stock)>0 && o.store_id!=null);
 const sellers=new Set(eligible.map(o=>String(o.store_id)));
 const prices=eligible.map(o=>Number(o.price));
 return {
  editionCount:editions.length,
  sellerCount:sellers.size,
  minPrice:prices.length?Math.min(...prices):null,
  digitalCount:digital.length,
  editionSelected:Boolean(selectedEdition),
  selectedIsbn:selectedEdition?.isbn||null
 };
}
module.exports={overview};
