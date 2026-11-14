'use strict';
// Accessible, link-based format selection: never implies payment availability.
function formatNavigation(selected='print'){
 const links=[
  {id:'print',href:'/books',label:'کتاب‌های چاپی',sub:'معرفی، چاپ‌ها و کتاب‌فروشی‌ها',icon:'▤'},
  {id:'digital',href:'/pdf-books',label:'کتاب‌های PDF',sub:'فایل‌های دیجیتال دارای پرونده مجوز',icon:'▧'}
 ];
 return `<nav class="format-navigation" aria-label="انتخاب نوع کتاب">${links.map(link=>`<a class="format-option${selected===link.id?' is-active':''}" href="${link.href}" ${selected===link.id?'aria-current="page"':''}><span class="format-icon" aria-hidden="true">${link.icon}</span><span class="format-copy"><strong>${link.label}</strong><small>${link.sub}</small></span><span class="format-chevron" aria-hidden="true">←</span></a>`).join('')}</nav>`;
}
function availabilityNotice(){return '<p class="storefront-caution">ویترین برای معرفی و بررسی کتاب‌ها فعال است؛ پرداخت آنلاین و تحویل سفارش واقعی هنوز فعال نشده‌اند.</p>';}
module.exports={formatNavigation,availabilityNotice};
