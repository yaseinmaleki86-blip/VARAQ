'use strict';
// Browser-only cart, server-validated DEMO checkout. It cannot pay or reserve inventory.
(() => {
  const key='varaq_cart_v1';
  const read=()=>{try{const a=JSON.parse(localStorage.getItem(key)||'[]');return Array.isArray(a)?a.filter(x=>Number.isSafeInteger(x.id)&&x.id>0&&Number.isSafeInteger(x.price)&&x.price>=0&&Number.isSafeInteger(x.qty)&&x.qty>0).slice(0,100):[];}catch{return [];}};
  const save=v=>{try{localStorage.setItem(key,JSON.stringify(v));refresh();return true;}catch{toast('ذخیره سبد در مرورگر ممکن نیست؛ تنظیمات ذخیره‌سازی را بررسی کنید.');return false;}};
  const fmt=n=>new Intl.NumberFormat('fa-IR').format(n);
  const el=(type,cls='',text='')=>{const e=document.createElement(type);if(cls)e.className=cls;if(text)e.textContent=text;return e;};
  function toast(msg){document.querySelector('.toast')?.remove();const t=el('div','toast',msg);document.body.append(t);setTimeout(()=>t.remove(),3200);}
  function refresh(){const cart=read();document.querySelectorAll('.cart-count').forEach(x=>x.textContent=fmt(cart.reduce((n,x)=>n+x.qty,0)));
    const root=document.getElementById('cart-root');if(!root)return;root.replaceChildren();
    if(!cart.length){const empty=el('div','v57-empty-cart');empty.append(el('p','','سبد انتخاب‌های شما خالی است. هنوز هیچ سفارشی ثبت نشده است.'));const link=el('a','cta','مرور کتاب‌های چاپی');link.href='/books';empty.append(link);root.append(empty);return;}
    const groups=new Map();let total=0;
    for(const c of cart){total+=c.price*c.qty;const sid=Number(c.storeId)||0;if(!groups.has(sid))groups.set(sid,[]);groups.get(sid).push(c);}
    for(const [storeId,books] of groups){const section=el('section','demo-store-section');section.append(el('h2','',books[0].store||'فروشگاه نامشخص'));
      let subtotal=0;
      for(const b of books){subtotal+=b.qty*b.price;const row=el('div','cart-row');const validSlug=typeof b.slug==='string'&&/^book-[a-zA-Z0-9-]{1,64}$/.test(b.slug);const name=el(validSlug?'a':'span','v57-cart-book',b.title);if(validSlug)name.href='/book/'+encodeURIComponent(b.slug);row.append(name);row.append(el('small','',fmt(b.price)+' تومان × '+fmt(b.qty)+' · ذخیره‌شده، نه مبلغ قطعی'));
        const controls=el('div','cart-controls');const minus=el('button','', '−');minus.type='button';minus.setAttribute('aria-label','کاهش تعداد '+b.title);minus.addEventListener('click',()=>{const items=read(),target=items.find(x=>x.id===b.id);if(target){target.qty--;save(items.filter(x=>x.qty>0));}});
        const plus=el('button','', '+');plus.type='button';plus.setAttribute('aria-label','افزایش تعداد '+b.title);plus.addEventListener('click',()=>{const items=read(),target=items.find(x=>x.id===b.id);if(target){target.qty=Math.min(5,target.qty+1);save(items);}});
        const remove=el('button','', 'حذف');remove.type='button';remove.setAttribute('aria-label','حذف '+b.title+' از سبد');remove.addEventListener('click',()=>save(read().filter(x=>x.id!==b.id)));
        controls.append(minus,plus,remove);row.append(controls);section.append(row);
      }
      section.append(el('h3','', 'جمع ذخیره‌شده در مرورگر: '+fmt(subtotal)+' تومان (غیرقطعی)'));
      if(!storeId){section.append(el('p','soft-warning','این کتاب از نسخه قبلی سبد باقی مانده است. برای ثبت درخواست نمونه، یک بار حذف و مجدد از صفحه کتاب اضافه کن.'));root.append(section);continue;}
      if(books.length>15||books.some(x=>x.qty>5)||books.reduce((n,x)=>n+x.qty,0)>30){section.append(el('p','soft-warning','برای ثبت نمونه حداکثر ۱۵ عنوان و حداکثر ۵ جلد از هر عنوان انتخاب کن.'));root.append(section);continue;}
      const form=el('form','demo-checkout-form form-grid');form.method='post';form.action='/demo-order';
      const hidden=(name,value)=>{const i=el('input');i.type='hidden';i.name=name;i.value=value;form.append(i);return i;};
      hidden('token',root.dataset.demoToken);hidden('store_id',String(storeId));
      hidden('client_ref',typeof crypto.randomUUID==='function'?crypto.randomUUID():Array.from(crypto.getRandomValues(new Uint8Array(16)),x=>x.toString(16).padStart(2,'0')).join(''));
      const itemsInput=hidden('items','');
      const field=(label,name,placeholder,max=80)=>{const l=el('label');l.textContent=label;const input=el('input');input.name=name;input.required=true;input.maxLength=max;input.placeholder=placeholder;l.append(input);form.append(l);return input;};
      field('نام مستعار آزمایشی','customer_alias','مثلاً مشتری نمونه',60);
      field('شهر نمونه','city','مثلاً شهر آزمایشی',60);
      const addr=field('نشانی ساختگی (نه آدرس واقعی)','sample_address','مثلاً خیابان فرضی، پلاک نمونه',240);addr.required=false;addr.parentElement.classList.add('full');
      const shipping=el('label');shipping.textContent='روش تحویل فرضی';const select=el('select');select.name='shipping_method';
      for(const [v,label] of [['pickup','تحویل حضوری (آزمایشی)'],['post','پست (آزمایشی)'],['courier','پیک (آزمایشی)']]){const op=el('option');op.value=v;op.textContent=label;select.append(op);}shipping.append(select);form.append(shipping);
      const consent=el('label','checkbox-line full');const cb=el('input');cb.type='checkbox';cb.name='demo_consent';cb.value='1';cb.required=true;consent.append(cb,document.createTextNode('تأیید می‌کنم سفارش، مشخصات مشتری و نشانی کاملاً آزمایشی‌اند و هیچ پرداخت یا ارسال واقعی انجام نمی‌شود.'));form.append(consent);
      const honey=el('input');honey.name='website';honey.tabIndex=-1;honey.autocomplete='off';honey.className='honeypot';honey.setAttribute('aria-hidden','true');form.append(honey);
      const button=el('button','cta full','ثبت سفارش نمونه بدون پرداخت');button.type='submit';button.disabled=true;form.append(button);
      let verified=false;
      form.addEventListener('submit',e=>{const current=read().filter(c=>Number(c.storeId)===storeId);if(!current.length||!verified){e.preventDefault();toast('ابتدا موجودی و مبلغ تأییدشده را بررسی کنید.');return;}itemsInput.value=JSON.stringify(current.map(x=>({id:x.id,qty:x.qty,expected_price:x.price})));button.disabled=true;button.textContent='ثبت آزمایشی در حال ارسال…';});
      const quoteArea=el('div','demo-quote-area');quoteArea.setAttribute('aria-live','polite');
      const quoteTitle=el('h3','','گام ۱ · بررسی قیمت و موجودی سرور');
      const quoteStatus=el('p','muted','در حال استعلام قیمت و موجودی…');
      const quoteList=el('div','demo-quote-list');
      const retry=el('button','outline','بررسی مجدد قیمت و موجودی');retry.type='button';
      quoteArea.append(quoteTitle,quoteStatus,quoteList,retry);section.append(quoteArea);
      const step=el('h3','','گام ۲ · ثبت سفارش صرفاً نمایشی');section.append(step,form);root.append(section);
      async function verifyQuote(){verified=false;button.disabled=true;retry.disabled=true;quoteList.replaceChildren();quoteStatus.textContent='در حال استعلام از سرور…';
        const requested=read().filter(x=>Number(x.storeId)===storeId);
        try{
          const payload=new URLSearchParams({token:root.dataset.demoToken,store_id:String(storeId),items:JSON.stringify(requested.map(x=>({id:x.id,qty:x.qty})))});
          const response=await fetch('/demo-order/preview',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:payload,credentials:'same-origin'});
          const result=await response.json();if(!section.isConnected)return;
          if(!response.ok||!result.ready){quoteStatus.textContent=result.error||'سبد آماده ثبت نیست؛ موجودی یا اطلاعات چاپ باید اصلاح شود.';quoteArea.classList.add('v57-quote-warning');}else{quoteArea.classList.remove('v57-quote-warning');}
          if(!Array.isArray(result.rows))return;
          let changed=false;
          for(const item of result.rows){const row=el('div','demo-quote-row');row.append(el('strong','',item.title));
            const current=requested.find(x=>x.id===item.id),oldPrice=current?.price;
            if(!item.ready){row.append(el('span','demo-quote-error',item.reason));}
            else{row.append(el('span','',fmt(item.qty)+' جلد × '+fmt(item.unitPrice)+' تومان = '+fmt(item.lineTotal)+' تومان'));
              if(item.discountPercent)row.append(el('small','',fmt(item.discountPercent)+'٪ تخفیف اعمال‌شده در سرور'));
              if(oldPrice!==item.unitPrice){changed=true;row.append(el('span','demo-quote-error','قیمت نسبت به سبد ذخیره‌شده تغییر کرده است.'));}
            }quoteList.append(row);
          }
          if(result.ready&&changed){quoteStatus.textContent='قیمت بعضی اقلام تغییر کرده؛ ابتدا قیمت‌های جدید را تأیید کنید.';
            const accept=el('button','cta','پذیرش قیمت جدید و استعلام دوباره');accept.type='button';accept.addEventListener('click',()=>{
              const rows=read();for(const item of result.rows){const existing=rows.find(x=>x.id===item.id&&Number(x.storeId)===storeId);if(existing&&item.ready)existing.price=item.unitPrice;}save(rows);
            });quoteList.append(accept);
          }else if(result.ready){verified=true;button.disabled=false;quoteStatus.textContent='✓ قیمت و موجودی بررسی شد. جمع کتاب‌های این فروشگاه: '+fmt(result.subtotal)+' تومان؛ هزینه تحویل مشخص نشده است. این استعلام رزرو کالا نیست.';}
        }catch{if(section.isConnected)quoteStatus.textContent='اتصال به سرور برقرار نشد؛ برای ادامه دوباره بررسی کنید.';}
        finally{if(section.isConnected)retry.disabled=false;}
      }
      retry.addEventListener('click',verifyQuote);
      void verifyQuote();
    }
    root.prepend(el('p','muted','جمع قیمت‌های ذخیره‌شده در مرورگر: '+fmt(total)+' تومان (غیرقطعی). مبلغ نهایی آزمایشی برای هر فروشگاه پس از استعلام سرور نشان داده می‌شود؛ هزینه ارسال مشخص نشده است.'));
  }
  document.querySelectorAll('.add-cart').forEach(b=>b.addEventListener('click',()=>{
    const id=Number(b.dataset.offer),price=Number(b.dataset.price),storeId=Number(b.dataset.storeId);
    if(!Number.isSafeInteger(id)||!Number.isSafeInteger(storeId)||!Number.isSafeInteger(price)||price<=0)return;
    const cart=read();const existing=cart.find(x=>x.id===id);const subset=cart.filter(x=>Number(x.storeId)===storeId);if(existing){if(b.dataset.bookSlug)existing.slug=b.dataset.bookSlug;if(b.dataset.title)existing.title=b.dataset.title;if(b.dataset.store)existing.store=b.dataset.store;if(existing.qty>=5){toast('حداکثر پنج جلد از این عنوان را می‌توانید به سبد آزمایشی اضافه کنید.');return;}if(subset.reduce((sum,x)=>sum+x.qty,0)>=30){toast('ظرفیت نمونه این فروشگاه ۳۰ جلد است.');return;}existing.qty++;}else{if(subset.length>=15||subset.reduce((sum,x)=>sum+x.qty,0)>=30){toast('حداکثر ۱۵ عنوان و ۳۰ جلد برای هر فروشگاه در سفارش نمونه مجاز است.');return;}cart.push({id,storeId,price,title:b.dataset.title||'',store:b.dataset.store||'',slug:b.dataset.bookSlug||'',qty:1});}if(save(cart))toast('به سبد آزمایشی اضافه شد؛ پرداخت یا خرید واقعی انجام نمی‌شود.');
  }));
  const csvFile=document.getElementById('csv-file');
  if(csvFile){csvFile.addEventListener('change',async()=>{
    const file=csvFile.files?.[0],input=document.getElementById('csv-input');if(!file||!input)return;
    if(file.size>280000){toast('فایل CSV بزرگ است؛ آن را به چند بخش تقسیم کن.');csvFile.value='';return;}
    try{input.value=(await file.text()).replace(/^\uFEFF/,'');toast('فایل خوانده شد؛ ابتدا پیش‌نمایش را بررسی کن.');}catch{toast('خواندن فایل ممکن نشد.');}
  });}
  const educationCSV=document.getElementById('education-csv-file');
  if(educationCSV){educationCSV.addEventListener('change',async()=>{
    const file=educationCSV.files?.[0],input=document.getElementById('education-csv-input');if(!file||!input)return;
    if(file.size>175000){toast('حداکثر اندازه CSV آموزشی ۱۷۵ کیلوبایت است.');educationCSV.value='';return;}
    try{input.value=(await file.text()).replace(/^\uFEFF/,'');toast('فایل خوانده شد. ابتدا پیش‌نمایش را بررسی کن.');}catch{toast('خواندن فایل ممکن نشد.');}
  });}
  refresh();
})();

// v1.4 — locally saved reading list. No account, API calls, or sensitive data.
(() => {
  const KEY = 'varaq_reading_list_v1';
  const safe = slug => typeof slug==='string' && /^book-[a-zA-Z0-9-]{1,64}$/.test(slug);
  const read = () => {
    try {
      const raw=JSON.parse(localStorage.getItem(KEY)||'[]');
      if(!Array.isArray(raw))return [];
      const seen=new Set();
      return raw.filter(x=>x && safe(x.slug) && typeof x.title==='string' && !seen.has(x.slug) && (seen.add(x.slug),true))
        .slice(0,200).map(x=>({slug:x.slug,title:x.title.slice(0,160),author:String(x.author||'').slice(0,120),category:String(x.category||'').slice(0,120)}));
    } catch {return [];}  
  };
  const write = rows => {try{localStorage.setItem(KEY,JSON.stringify(rows));return true;}catch{return false;}};
  const counts = () => {const n=new Intl.NumberFormat('fa-IR').format(read().length+(function(){try{const a=JSON.parse(localStorage.getItem('varaq_pdf_saved_v81')||'[]');return Array.isArray(a)?Math.min(a.filter(x=>x&&Number.isSafeInteger(Number(x.id))&&Number(x.id)>0).length,150):0;}catch{return 0;}})());document.querySelectorAll('.shelf-count').forEach(e=>e.textContent=n);};
  const updateButtons = () => {
    const slugs=new Set(read().map(x=>x.slug));
    document.querySelectorAll('.save-book').forEach(b=>{
      const saved=slugs.has(b.dataset.bookSlug);
      b.setAttribute('aria-pressed',String(saved));
      const detail=b.classList.contains('detail-save');
      b.textContent=saved?(detail?'♥ حذف از فهرست مطالعه':'♥'):(detail?'♡ افزودن به فهرست مطالعه':'♡');
      b.setAttribute('aria-label',(saved?'حذف از فهرست مطالعه: ':'نشان‌کردن کتاب: ')+(b.dataset.bookTitle||''));
    });
    counts();
  };
  document.querySelectorAll('.save-book').forEach(b=>b.addEventListener('click',()=>{
    const slug=b.dataset.bookSlug;
    if(!safe(slug))return;
    let items=read();
    if(items.some(x=>x.slug===slug))items=items.filter(x=>x.slug!==slug);
    else if(items.length<200)items.unshift({slug,title:(b.dataset.bookTitle||'کتاب').slice(0,160),author:(b.dataset.bookAuthor||'').slice(0,120),category:(b.dataset.bookCategory||'').slice(0,120)});
    if(write(items))updateButtons();
  }));
  const shelf=document.getElementById('saved-root');
  if(shelf){
    const make=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text)n.textContent=text;return n;};
    const draw=()=>{
      shelf.replaceChildren();const rows=read();counts();
      if(!rows.length){const empty=make('div','v14-saved-empty','هنوز کتابی نشان نکرده‌ای. از فهرست کتاب‌ها، علامت ♡ را انتخاب کن.');const link=make('a','','رفتن به کتابخانه');link.href='/books';empty.append(link);shelf.append(empty);return;}
      for(const book of rows){
        const entry=make('article','v14-saved-entry');const title=make('h2','',book.title);const meta=make('p','',[book.author,book.category].filter(Boolean).join(' · ')||'اطلاعات کتاب در حال تکمیل است');const actions=make('div','v14-saved-actions');const link=make('a','','مشاهده کتاب ←');link.href='/book/'+encodeURIComponent(book.slug);const remove=make('button','','حذف از فهرست');remove.type='button';remove.addEventListener('click',()=>{write(read().filter(x=>x.slug!==book.slug));draw();updateButtons();});actions.append(link,remove);entry.append(title,meta,actions);shelf.append(entry);
      }
    };
    document.getElementById('clear-saved')?.addEventListener('click',()=>{if(!read().length)return;if(window.confirm('تمام کتاب‌های نشان‌شده از همین مرورگر حذف شوند؟')){write([]);draw();updateButtons();}});
    draw();
  }
  updateButtons();
  // VARAQ 8.1: private, browser-only reminders for public digital catalogue entries.
  // A saved ID never grants PDF access; all server-side rights checks stay authoritative.
  const PDF_KEY='varaq_pdf_saved_v81';
  const pdfId=id=>Number.isSafeInteger(Number(id))&&Number(id)>0&&Number(id)<=2147483647;
  const pdfRead=()=>{
    try{const raw=JSON.parse(localStorage.getItem(PDF_KEY)||'[]');const seen=new Set();
      return Array.isArray(raw)?raw.filter(x=>x&&pdfId(x.id)&&typeof x.title==='string'&&!seen.has(Number(x.id))&&(seen.add(Number(x.id)),true))
        .slice(0,150).map(x=>({id:Number(x.id),title:x.title.slice(0,160),store:String(x.store||'').slice(0,120)})):[];
    }catch{return [];}
  };
  const pdfWrite=items=>{try{localStorage.setItem(PDF_KEY,JSON.stringify(items));return true;}catch{return false;}};
  const pdfButtonsUpdate=()=>{
    const chosen=new Set(pdfRead().map(x=>x.id));
    document.querySelectorAll('.save-pdf').forEach(button=>{
      const selected=chosen.has(Number(button.dataset.pdfId));
      button.setAttribute('aria-pressed',String(selected));
      button.textContent=selected?'♥ حذف از نشان‌شده‌ها':'♡ ذخیره PDF برای بعد';
      button.setAttribute('aria-label',(selected?'حذف از نشان‌شده‌ها: ':'ذخیره برای بعد: ')+(button.dataset.pdfTitle||'PDF'));
    });
    const count=pdfRead().length+read().length;
    document.querySelectorAll('.shelf-count').forEach(x=>x.textContent=new Intl.NumberFormat('fa-IR').format(count));
  };
  document.querySelectorAll('.save-pdf').forEach(button=>button.addEventListener('click',()=>{
    const id=Number(button.dataset.pdfId);if(!pdfId(id))return;
    const previous=pdfRead();
    const next=previous.some(x=>x.id===id)?previous.filter(x=>x.id!==id):
      [{id,title:String(button.dataset.pdfTitle||'کتاب دیجیتال').slice(0,160),store:String(button.dataset.pdfStore||'').slice(0,120)},...previous].slice(0,150);
    if(pdfWrite(next)){pdfButtonsUpdate();drawPdfSaved();}
  }));
  const pdfShelf=document.getElementById('saved-pdf-root');
  const makePdfNode=(tag,cls,text)=>{const el=document.createElement(tag);if(cls)el.className=cls;if(text)el.textContent=text;return el;};
  function drawPdfSaved(){
    if(!pdfShelf)return;
    pdfShelf.replaceChildren();const rows=pdfRead();
    if(!rows.length){const empty=makePdfNode('div','v14-saved-empty','هنوز هیچ PDF را نشان نکرده‌ای.');const link=makePdfNode('a','','رفتن به کتاب‌های PDF');link.href='/pdf-books';empty.append(link);pdfShelf.append(empty);return;}
    for(const item of rows){
      const card=makePdfNode('article','v14-saved-entry v81-pdf-saved-entry');card.append(makePdfNode('span','v48-digital-label','نسخه دیجیتال · PDF'),makePdfNode('h2','',item.title),makePdfNode('p','',item.store?'فروشگاه: '+item.store:'وضعیت عرضه نیازمند بررسی مجدد'));
      const actions=makePdfNode('div','v14-saved-actions');const link=makePdfNode('a','','بررسی وضعیت و مشخصات ←');link.href='/pdf-books/'+item.id;
      const del=makePdfNode('button','','حذف از فهرست');del.type='button';del.addEventListener('click',()=>{pdfWrite(pdfRead().filter(x=>x.id!==item.id));drawPdfSaved();pdfButtonsUpdate();});
      actions.append(link,del);card.append(actions);pdfShelf.append(card);
    }
  }
  document.getElementById('clear-pdf-saved')?.addEventListener('click',()=>{if(pdfRead().length&&window.confirm('PDFهای نشان‌شده از همین مرورگر پاک شوند؟')){pdfWrite([]);drawPdfSaved();pdfButtonsUpdate();}});
  drawPdfSaved();pdfButtonsUpdate();
  const menu=document.querySelector('.mobile-menu-toggle');const nav=document.getElementById('site-main-nav');
  const backdrop=document.querySelector('.mobile-nav-backdrop');const closeButton=document.querySelector('.mobile-nav-close');
  if(menu&&nav&&backdrop&&closeButton){
    nav.classList.add('enhanced-nav');
    const isMobile=()=>window.matchMedia('(max-width:740px)').matches;
    const setOpen=(open,returnFocus=false)=>{
      const active=Boolean(open&&isMobile());
      nav.classList.toggle('is-open',active);
      backdrop.classList.toggle('is-open',active);
      document.body.classList.toggle('menu-open',active);
      menu.setAttribute('aria-expanded',String(active));
      if(active)closeButton.focus();else if(returnFocus&&isMobile())menu.focus();
    };
    menu.addEventListener('click',()=>setOpen(!nav.classList.contains('is-open')));
    closeButton.addEventListener('click',()=>setOpen(false,true));
    backdrop.addEventListener('click',()=>setOpen(false,true));
    nav.querySelectorAll('a').forEach(link=>link.addEventListener('click',()=>setOpen(false)));
    document.addEventListener('keydown',event=>{
      if(!nav.classList.contains('is-open'))return;
      if(event.key==='Escape'){event.preventDefault();setOpen(false,true);return;}
      if(event.key!=='Tab')return;
      const focusable=Array.from(nav.querySelectorAll('a[href],button:not([disabled])')).filter(el=>el.getClientRects().length);
      if(!focusable.length)return;
      const first=focusable[0],last=focusable[focusable.length-1];
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
    });
    window.addEventListener('resize',()=>{if(!isMobile()&&nav.classList.contains('is-open'))setOpen(false);});
  }
  const panelToggle=document.querySelector('.panel-nav-toggle');const panelLinks=document.getElementById('panel-section-links');
  if(panelToggle&&panelLinks){
    const mobile=()=>window.matchMedia('(max-width:740px)').matches;
    panelLinks.classList.add('enhanced-panel-nav');
    const setPanelOpen=open=>{panelLinks.classList.toggle('is-open',open);panelToggle.setAttribute('aria-expanded',String(open));};
    panelToggle.addEventListener('click',()=>setPanelOpen(!panelLinks.classList.contains('is-open')));
    window.addEventListener('resize',()=>{if(!mobile())setPanelOpen(false);});
  }
})();

// VARAQ 1.9: external real-cover errors fall back to an honest missing-image notice.
document.addEventListener('error',function(event){
  const img=event.target;
  if(img&&img.tagName==='IMG'&&img.classList.contains('external-cover')){
    img.hidden=true;
    if(img.parentElement)img.parentElement.classList.add('cover-unavailable');
    const card=img.closest('.book-cover-wrap');
    const badge=card?.querySelector('.v48-cover-status.has-picture');
    if(badge){badge.textContent='طرح اختصاصی';badge.classList.remove('has-picture');badge.classList.add('varaq-concept-status');badge.hidden=false;}
  }
},true);

// v4.2: user-requested print sheet; no inline scripts, compliant with CSP.
document.querySelectorAll('.print-page-action').forEach(button=>button.addEventListener('click',()=>window.print()));

// 5.3: load the user's local editorial CSV into the existing two-step preview form.
(() => {
 const input=document.getElementById('content-workbook-upload');
 const textarea=document.getElementById('content-workbook-text');
 const status=document.getElementById('content-workbook-file-status');
 if(!input||!textarea||!status)return;
 input.addEventListener('change',async()=>{
  const file=input.files?.[0];if(!file)return;
  if(file.size>55000){status.textContent='حجم فایل بیشتر از ۵۵ کیلوبایت است. فایل را به بسته‌های کوچک‌تر تقسیم کنید.';input.value='';return;}
  try{
   const content=await file.text();
   if(content.length>55000){status.textContent='متن فایل طولانی است. بسته‌های حداکثر ۵۰ کتاب انتخاب کنید.';return;}
   textarea.value=content;
   status.textContent='فایل بارگذاری شد؛ قبل از ارسال، منبع و متن هر ردیف را بررسی کنید.';
  }catch{status.textContent='خواندن فایل ممکن نشد؛ متن CSV را دستی وارد کنید.';}
 });
})();

// VARAQ 5.5: image previews stay on the user's device until explicit submission.
// Never send selected files to third parties and do not auto-submit the form.
(() => {
 const pickers=document.querySelectorAll('input[data-cover-preview]');
 for(const picker of pickers){
  const slot=document.querySelector(`[data-cover-slot="${picker.dataset.coverPreview}"]`);
  if(!slot)continue;
  picker.addEventListener('change',()=>{
   slot.replaceChildren();const file=picker.files?.[0];
   if(!file){slot.textContent='پیش‌نمایش تصویر انتخاب‌نشده';return;}
   if(file.size>700*1024||!['image/png','image/jpeg','image/webp'].includes(file.type)){
    slot.textContent='تصویر بیش از ۷۰۰ کیلوبایت است یا نوع فایل پشتیبانی نمی‌شود. اعتبارسنجی قطعی هنگام ارسال در سرور انجام می‌شود.';return;
   }
   const description=document.createElement('span');description.textContent=`${file.name.slice(0,100)} · ${(file.size/1024).toFixed(0)} کیلوبایت`;
   const img=new Image();img.alt='پیش‌نمایش محلی تصویر انتخاب‌شده؛ تطبیق و مجوز هنوز تأیید نشده';
   img.addEventListener('load',()=>{description.textContent+=` · ${img.naturalWidth} × ${img.naturalHeight} پیکسل`;});
   img.addEventListener('error',()=>{img.remove();description.textContent+=' · پیش‌نمایش تصویر ممکن نیست';});
   slot.append(img,description);
   const reader=new FileReader();reader.addEventListener('load',()=>{if(picker.files?.[0]===file)img.src=String(reader.result);});
   reader.addEventListener('error',()=>{slot.replaceChildren();slot.textContent='خواندن تصویر ممکن نیست.';});
   reader.readAsDataURL(file);
  });
 }
})();

// VARAQ 5.7: mobile catalog filters, with a fully visible no-JS fallback.
(() => {
 const toggle=document.querySelector('.catalog-filter-toggle');
 const panel=document.getElementById('catalog-filter-panel');
 if(!toggle||!panel)return;
 const mobile=window.matchMedia('(max-width:740px)');
 let touched=false;
 const setOpen=open=>{panel.classList.toggle('v57-collapsed',!open);toggle.setAttribute('aria-expanded',String(open));};
 const sync=()=>{if(!mobile.matches){setOpen(true);return;}setOpen(touched?toggle.getAttribute('aria-expanded')==='true':Number(toggle.dataset.activeFilters)>0);};
 toggle.classList.add('v57-enhanced');panel.classList.add('v57-enhanced');sync();
 toggle.addEventListener('click',()=>{touched=true;const open=toggle.getAttribute('aria-expanded')!=='true';setOpen(open);if(open)panel.querySelector('input,select')?.focus();});
 mobile.addEventListener('change',sync);
})();

// VARAQ 6.8: accessibility preferences for the reader, stored only in this browser.
// Does not save books visited, scroll position, sample text, purchase data or usage analytics.
(() => {
 const sheet=document.querySelector('.v67-reader-sheet');if(!sheet)return;
 const page=sheet.closest('.v67-reading-page');
 const KEY='varaq-reader-display-v68';
 const defaults={size:1.18,dark:false,spacious:false,focus:false};
 let pref={...defaults};
 try{
  const value=JSON.parse(window.localStorage.getItem(KEY)||'null');
  if(value&&typeof value==='object'){
   if(Number.isFinite(value.size))pref.size=Math.max(.95,Math.min(1.65,value.size));
   for(const name of ['dark','spacious','focus'])if(typeof value[name]==='boolean')pref[name]=value[name];
  }
 }catch{}
 const contrast=sheet.querySelector('[data-reading-contrast]');
 const spacing=sheet.querySelector('[data-reading-spacing]');
 const focus=sheet.querySelector('[data-reading-focus]');
 const progress=sheet.querySelector('.v68-reader-progress');
 function render(){
  sheet.style.setProperty('--v67-reading-size',pref.size.toFixed(2)+'rem');
  sheet.classList.toggle('v67-dark',pref.dark);
  sheet.classList.toggle('v68-spacious',pref.spacious);
  page?.classList.toggle('v68-focus',pref.focus);
  if(contrast){contrast.setAttribute('aria-pressed',String(pref.dark));contrast.textContent=pref.dark?'حالت مطالعه روشن':'حالت مطالعه تیره';}
  if(spacing){spacing.setAttribute('aria-pressed',String(pref.spacious));spacing.textContent=pref.spacious?'فاصله خطوط عادی':'فاصله خطوط بیشتر';}
  if(focus){focus.setAttribute('aria-pressed',String(pref.focus));focus.textContent=pref.focus?'نمایش همه بخش‌ها':'مطالعه متمرکز';}
 }
 function save(){try{window.localStorage.setItem(KEY,JSON.stringify(pref));}catch{}}
 sheet.querySelectorAll('[data-reading-font]').forEach(button=>button.addEventListener('click',()=>{
  pref.size=Math.max(.95,Math.min(1.65,Math.round((pref.size+(button.dataset.readingFont==='larger'?.1:-.1))*100)/100));render();save();
 }));
 contrast?.addEventListener('click',()=>{pref.dark=!pref.dark;render();save();});
 spacing?.addEventListener('click',()=>{pref.spacious=!pref.spacious;render();save();});
 focus?.addEventListener('click',()=>{pref.focus=!pref.focus;render();save();});
 sheet.querySelector('[data-reading-reset]')?.addEventListener('click',()=>{pref={...defaults};render();save();});
 render();
 // Visual progress indicates only how much of this page is in view, not book completion.
 let scheduled=false;
 function updateProgress(){
  scheduled=false;if(!progress)return;
  const rect=sheet.getBoundingClientRect();
  const length=Math.max(1,sheet.offsetHeight-window.innerHeight);
  const passed=Math.max(0,Math.min(100,Math.round((-rect.top/length)*100)));
  progress.firstElementChild.style.width=passed+'%';
  progress.setAttribute('aria-valuenow',String(passed));
 }
 function schedule(){if(scheduled)return;scheduled=true;window.requestAnimationFrame(updateProgress);}
 if(progress){window.addEventListener('scroll',schedule,{passive:true});window.addEventListener('resize',schedule);schedule();}
})();


// VARAQ 7.1: compare 2–3 books directly on the current catalog page.
// Selection never leaves this page until the visitor submits the GET form.
// Without JavaScript, the native checkboxes and comparison route still work.
(() => {
 const form=document.querySelector('.v71-compare-form');if(!form)return;
 const boxes=[...form.querySelectorAll('.v71-compare-choice input[type="checkbox"][name="book"]')];
 const count=form.querySelector('#v71-compare-count');
 const clear=form.querySelector('.v71-compare-clear');
 const submit=form.querySelector('.v71-compare-submit');
 const label=(n)=>new Intl.NumberFormat('fa-IR').format(n)+' از ۳ انتخاب‌شده';
 function sync(){
  const selected=boxes.filter(x=>x.checked);
  if(count)count.textContent=label(selected.length)+(selected.length===1?' · یک کتاب دیگر انتخاب کن':'');
  if(submit)submit.disabled=selected.length<2||selected.length>3;
  if(clear)clear.hidden=!selected.length;
  for(const input of boxes){input.disabled=!input.checked&&selected.length>=3;}
 }
 for(const box of boxes)box.addEventListener('change',sync);
 clear?.addEventListener('click',()=>{for(const box of boxes){box.checked=false;box.disabled=false;}sync();boxes[0]?.focus();});
 form.addEventListener('submit',event=>{const n=boxes.filter(x=>x.checked).length;if(n<2||n>3){event.preventDefault();if(count){count.textContent='برای مقایسه، ۲ یا ۳ کتاب انتخاب کن.';count.focus?.();}}});
 sync();
})();
