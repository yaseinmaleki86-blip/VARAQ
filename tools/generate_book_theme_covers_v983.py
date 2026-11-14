#!/usr/bin/env python3
"""Original concept-art cover illustrator for VARAQ's 1,000-item catalog.
Renders 980 individual book-specific painterly illustrations and thumbnails.
Existing first 20 illustrated covers remain unchanged. No publisher cover claim.
"""
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont,ImageFilter
import hashlib,math,random,re,json,os,sys,time,colorsys,collections
import numpy as np

ROOT=Path(__file__).resolve().parents[1]
BOOKS=json.loads((ROOT/'data/books.json').read_text(encoding='utf8'))
OUT=ROOT/'public/concept-art';THUMB=ROOT/'public/concept-thumb'
W,H=480,672
FB='/usr/share/fonts/truetype/noto/NotoSansArabic-Bold.ttf'
FM='/usr/share/fonts/truetype/noto/NotoSansArabic-Regular.ttf'
FE='/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf'
FER='/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf'

def seed(b):return int(hashlib.sha256((str(b['id'])+':'+b['title']+':'+str(b.get('author',''))).encode()).hexdigest()[:16],16)
def rgbhex(c):return tuple(max(0,min(255,int(v))) for v in c)
def blend(a,b,t):return tuple(int(a[i]*(1-t)+b[i]*t) for i in range(3))
def rgba(c,a=255):return tuple(c)+(a,)
def dark(c,t=.4):return blend(c,(3,12,19),t)
def light(c,t=.4):return blend(c,(250,231,195),t)
def pt(r,x,y,sz=1):return int(x+r.uniform(-sz,sz)),int(y+r.uniform(-sz,sz))

PALETTES={
'romance':[[(31,52,65),(204,131,103),(249,201,134)],[(32,42,61),(113,120,144),(224,180,151)],[(20,53,63),(75,139,129),(239,184,119)],[(67,47,65),(170,103,118),(236,195,133)]],
'fantasy':[[(11,25,61),(54,82,130),(154,130,183)],[(19,37,44),(48,103,88),(178,152,92)],[(25,20,51),(92,54,103),(221,133,95)],[(21,49,69),(35,118,148),(178,210,201)]],
'crime':[[(10,22,34),(38,63,78),(166,133,107)],[(21,30,39),(63,81,93),(174,177,151)],[(34,28,44),(86,72,90),(189,109,92)]],
'child':[[(53,100,149),(137,197,208),(244,212,142)],[(69,91,147),(195,153,166),(252,212,154)],[(35,104,102),(96,176,157),(251,219,149)]],
'science':[[(10,27,59),(22,77,117),(46,181,171)],[(27,32,72),(69,71,138),(137,129,219)],[(11,51,65),(25,96,111),(143,191,175)]],
'business':[[(15,45,52),(47,96,98),(166,175,139)],[(23,40,60),(68,115,144),(193,181,148)],[(24,43,40),(68,107,76),(206,171,97)]],
'psych':[[(26,49,69),(98,118,132),(208,192,156)],[(28,52,65),(78,132,130),(206,180,152)],[(46,40,72),(137,111,145),(244,198,158)]],
'history':[[(44,41,47),(115,93,76),(209,177,125)],[(24,43,54),(113,98,94),(233,179,131)],[(40,42,56),(112,119,135),(225,187,137)]],
'poetry':[[(45,35,51),(112,64,82),(213,151,121)],[(22,53,60),(68,120,113),(214,187,121)]],
'horror':[[(9,19,28),(38,53,67),(110,94,95)],[(15,23,34),(54,58,69),(133,98,109)]],
'lifestyle':[[(21,62,75),(74,138,126),(229,198,145)],[(46,72,68),(133,152,114),(230,201,147)]]}

def genre(b):
 c=b.get('category') or ''
 if 'جنایی' in c:return 'crime'
 if 'ترسناک' in c:return 'horror'
 if 'فانتزی' in c:return 'fantasy'
 if 'کودک' in c:return 'child'
 if 'علم و فناوری' in c:return 'science'
 if 'اقتصاد' in c:return 'business'
 if 'روانشناسی' in c:return 'psych'
 if 'تاریخ' in c:return 'history'
 if 'شعر' in c:return 'poetry'
 if 'سبک زندگی' in c:return 'lifestyle'
 return 'romance'

# Explicit book-scene connections for recurring book-image topics, in two languages.
THEMES=[
 ('kite',r'بادبادک|kite|kites'),
 ('portrait',r'چشم|دختری که|portrait|picture of|girl with|face|eyes\b|eye\b'),
 ('autumn',r'پاییز|خزان|autumn|fall\b|foliage'),
 ('desert',r'کیمیاگر|صحرا|بیابان|کویر|alchemist|desert|sand|arabian|dune|sahara'),
 ('sea',r'دریا|جزیره|اقیانوس|ساحل|کشتی|دریانورد|sea\b|ocean|island|tide|whale|ship|pirate|boat|sail|moby|20,000 leagues|twenty thousand'),
 ('castle',r'قلعه|تخت|پادشاه|شاه|شوالیه|امپراتور|castle|kingdom|throne|king\b|queen\b|crown|prince|knight|royal|emperor'),
 ('garden',r'باغ|گل|بهار|درخت|انار|گلستان|garden|flower|rose|botan|bloom|tree|seed|secret garden'),
 ('noir',r'جنایت|قتل|راز|معما|پلیس|کارآگاه|شرلوک|crime|murder|detective|sherlock|mystery|investigat|silent witness|case.book'),
 ('sky',r'آسمان|ستاره|ماه|خورشید|فضا|کیهان|کهکشان|universe|cosmos|star|moon|galaxy|planet|orbit|space|astronom|gravity|solar|sky'),
 ('forest',r'جنگل|گرگ|روباه|برگ|forest|wood|wolf|fox|wild|greenwood|leaf|woodland|jungle|earthsea'),
 ('train',r'قطار|سفر|راه آهن|station|train|railway|journey|travel|road|highway'),
 ('city',r'شهر|خیابان|تهران|پاریس|نیویورک|لندن|city|street|paris|london|new york|urban|metropolis|district|neighborhood'),
 ('mountain',r'کوه|قله|برف|صعود|کلبه|mountain|summit|climb|peak|snow|ridge|heights|altitude'),
 ('rain',r'باران|اشک|ابر|طوفان|rain|storm|cloud|thunder|lightning|weather'),
 ('fire',r'آتش|جنگ|نبرد|خشم|انقلاب|fire\b|flame|war\b|battle|burn|revolution|fury|wrath'),
 ('library',r'کتاب|نامه|نویسنده|کتابخانه|خواندن|book|letter|library|reader|write|novel|journal|diary|story'),
 ('clock',r'زمان|ساعت|تاریخ|گذشته|memory|time|clock|history|moment|eternity|ages|century'),
 ('heart',r'عشق|دوست|زندگی|رابطه|خانواده|love|heart|romance|marriage|lover|friend|wife|husband|wedding|affair|daughter|son'),
 ('brain',r'مغز|ذهن|هوش|روان|فکر|brain|mind|memory|psycho|intelligence|neuro|thinking|consciousness'),
 ('growth',r'عادت|موفقیت|انگیزه|رشد|تغییر|growth|habit|success|change|focus|progress|improve|transform|compound'),
 ('money',r'پول|ثروت|اقتصاد|سرمایه|فروش|بازار|money|wealth|invest|finance|stock|market|econom|trading|sell|cash|business'),
 ('lab',r'علم|فیزیک|شیمی|زیست|آزمایش|medicine|physics|chemistry|science|atom|quantum|formula|molecule|cell|laboratory'),
 ('child',r'کودک|بچه|نوجوان|دختر|پسر|child|boy|girl|kid|little|alice|wonderland|fairy|storybook'),
 ('house',r'خانه|آپارتمان|عمارت|دروازه|اتاق|house|home|room|mansion|door|apartment|manor|cottage'),
 ('bird',r'پرنده|بادبادک|آزادی|پرواز|bird|kite|flight|wing|raven|heron|songbird'),
 ('temple',r'فلسفه|خدا|افسانه|اسطوره|بودیسم|معنویت|خرد|god|gods|myth|philosophy|spirit|temple|soul|religion|ancient'),
 ('sports',r'ورزش|فوتبال|بسکتبال|دویدن|baseball|football|sports|game|team|win|players|tennis|running'),
 ('tech',r'تکنولوژی|کامپیوتر|روبات|شبکه|هوش مصنوعی|robot|computer|technology|code|digital|future|machine|cyber|internet|algorithm'),
 ('coffee',r'قهوه|کافه|آشپزی|غذا|آشپزخانه|coffee|cafe|cook|food|baking|recipe|tea'),
 ('music',r'موسیقی|آواز|سمفونی|رقص|music|symphony|song|dance|violin|piano|orchestra'),
]
DEFAULT={
 'romance':['portrait','garden','city','train','rain','heart','house','sea','mountain','library','coffee'],
 'fantasy':['castle','forest','sky','sea','temple','fire','mountain','bird'],
 'crime':['noir','rain','clock','city','house','library'],
 'horror':['forest','house','clock','noir','fire'],
 'child':['child','garden','forest','sky','sea','bird','house'],
 'science':['lab','sky','brain','tech','sea','mountain'],
 'business':['money','city','growth','sports','tech','clock'],
 'psych':['brain','growth','mountain','garden','sea','heart','rain'],
 'history':['temple','castle','library','clock','city','fire'],
 'poetry':['garden','temple','bird','sky','sea','rain'],
 'lifestyle':['coffee','garden','growth','house','mountain','sports']}

def theme_for(b,gen,r):
 title=b.get('title','').lower(); desc=(b.get('editorial_draft_fa') or '').lower()
 # Title first; generically-written editorial snippets must NOT override title-specific themes.
 for motif,pat in THEMES:
  if re.search(pat,title,re.I):return motif,'title'
 # Recognize meaningful story-specific text in the first 200 books, not generic extended catalog.
 if b['id']<=200:
  for motif,pat in THEMES:
   if re.search(pat,desc[:185],re.I) and motif not in ['library','growth','heart']:
    return motif,'synopsis'
 return r.choice(DEFAULT[gen]),'category'

def background(palette,r,style):
 top,mid,bot=palette
 yy=np.arange(H,dtype=np.float32)[:,None]; xx=np.arange(W,dtype=np.float32)[None,:]
 q=yy/H
 t=np.minimum(1, q*1.7)
 c=np.zeros((H,W,3),dtype=np.float32)
 for k in range(3):
  arr=top[k]*(1-t)+mid[k]*t
  arr=np.where(q<.67,arr, mid[k]*(1-np.minimum(1,(q-.67)/.33))+bot[k]*np.minimum(1,(q-.67)/.33))
  c[:,:,k]=arr
 noise=np.random.default_rng(r.randrange(2**32)).normal(0,3.8,size=(H,W)).astype(np.float32)
 # Subtle directional paper grain and twilight illumination
 wave=np.sin(xx*.021+yy*.014+r.random()*10)*3.5+np.sin(xx*.051-yy*.014)*2.1
 radial=np.exp(-(((xx-W*(.35+r.random()*.30))/(W*.49))**2+((yy-H*.34)/(H*.51))**2)*1.5)*15
 for k in range(3):c[:,:,k]=np.clip(c[:,:,k]+noise+wave+radial*(.80 if k==0 else .6 if k==1 else .4),0,255)
 return Image.fromarray(c.astype('uint8'),'RGB')

def circle(d,x,y,R,color,outline=None,width=1): d.ellipse((int(x-R),int(y-R),int(x+R),int(y+R)),fill=color,outline=outline,width=width)
def glow(im,x,y,radius,color):
 layer=Image.new('RGBA',(W,H));d=ImageDraw.Draw(layer)
 for f in [1.9,1.4,1.0]: circle(d,x,y,radius*f,rgba(color,int(26*(2.25-f))))
 layer=layer.filter(ImageFilter.GaussianBlur(18));return Image.alpha_composite(im.convert('RGBA'),layer)

def stars(d,r,n=85,c=(242,224,185)):
 for _ in range(n):
  x=r.randrange(12,W-12);y=r.randrange(16,435)
  rr=r.choice([1,1,1,2,2,3]);circle(d,x,y,rr,rgba(c,r.randrange(80,220)))
  if rr==3:
   d.line((x-6,y,x+6,y),fill=rgba(c,80));d.line((x,y-6,x,y+6),fill=rgba(c,70))

def clouds(d,r,n=9,tint=(228,200,167)):
 for _ in range(n):
  x=r.randint(-80,W);y=r.randint(35,300);s=r.randint(24,75)
  for k in range(3): d.ellipse((x-k*s//2,y-k*5,x+s*.6,y+s*.25),fill=rgba(tint,20+r.randrange(25)))

def hills(d,r,pal,base=370,n=4):
 for layer in range(n):
  y0=base-65+layer*45
  col=dark(pal[1],.20+layer*.14)
  pts=[(-5,570)]
  for x in range(-30,W+50,40):pts.append((x, int(y0+r.randint(-55,42)+23*math.sin(x/78+layer))))
  pts.extend([(W+4,560),(-5,560)]);d.polygon(pts,fill=rgba(col,240))

def water(d,r,pal,y=375):
 d.polygon([(0,y),(W,y-15),(W,550),(0,550)],fill=dark(pal[1],.21))
 for _ in range(120):
  x=r.randrange(W);yy=r.randrange(y,545);size=r.randrange(8,75)
  d.arc((x,yy,x+size,yy+3),180,355,fill=rgba(light(pal[2],.45),r.randint(75,155)),width=1)

def tree(d,r,x,y,s,pal,leaf=True):
 wood=dark(pal[0],.35)
 d.line([(x,y),(x+r.randint(-12,12)*s,y-88*s)],fill=wood,width=max(2,int(10*s)))
 for branch in range(5):
  dx=r.randint(-50,50)*s;dy=r.randint(-115,-35)*s
  d.line([(x,y-60*s),(x+dx,y+dy)],fill=wood,width=max(1,int(4*s)))
 if leaf:
  for _ in range(36):
   xx=x+r.gauss(0,34)*s;yy=y-100*s+r.gauss(0,30)*s;rr=r.randint(6,16)*s
   clr=r.choice([dark(pal[1],.34),dark(pal[1],.14),light(pal[1],.1),light(pal[2],.04)])
   d.ellipse((xx-rr,yy-rr*.6,xx+rr,yy+rr*.6),fill=clr)

def person(d,x,y,s,coat,skin=(199,147,120),r=None,cloak=False):
 # x/y is feet position.
 if r:rhead=r.uniform(-.12,.12)
 else:rhead=0
 head=max(5,int(9*s));circle(d,x+rhead*15,y-67*s,head,skin)
 d.polygon([(x-10*s,y-55*s),(x+11*s,y-54*s),(x+18*s,y-15*s),(x-18*s,y-13*s)],fill=coat)
 if cloak:d.polygon([(x-8*s,y-52*s),(x+8*s,y-52*s),(x+36*s,y-4*s),(x-32*s,y-4*s)],fill=coat)
 d.line((x-9*s,y-15*s,x-13*s,y),fill=dark(coat,.35),width=max(3,int(6*s)))
 d.line((x+9*s,y-15*s,x+12*s,y),fill=dark(coat,.35),width=max(3,int(6*s)))

def house(d,x,y,s,pal,lit=False):
 base=dark(pal[0],.15);window=(242,202,114) if lit else dark(pal[1],.55)
 d.rectangle((x-68*s,y-115*s,x+68*s,y),fill=base)
 d.polygon([(x-80*s,y-115*s),(x,y-180*s),(x+80*s,y-115*s)],fill=dark(pal[0],.40))
 for xx in (-40,7,37):
  for yy in (-87,-46):
   d.rectangle((x+xx*s,y+yy*s,x+(xx+15)*s,y+(yy+24)*s),fill=window)
 d.rectangle((x-12*s,y-48*s,x+13*s,y),fill=dark(pal[1],.25))

def castle(d,x,y,s,pal):
 col=dark(pal[0],.25);lite=light(pal[2],.3)
 d.rectangle((x-87*s,y-105*s,x+87*s,y),fill=col)
 for tx,hh in [(-105,176),(-44,149),(35,181),(100,160)]:
  d.rectangle((x+(tx-15)*s,y-hh*s,x+(tx+15)*s,y),fill=col)
  d.polygon([(x+(tx-24)*s,y-hh*s),(x+tx*s,y-(hh+42)*s),(x+(tx+24)*s,y-hh*s)],fill=dark(pal[0],.43))
  d.ellipse((x+(tx-6)*s,y-(hh-10)*s,x+(tx+6)*s,y-(hh-28)*s),fill=lite)
 d.arc((x-18*s,y-64*s,x+18*s,y+8*s),180,360,fill=lite,width=max(2,int(3*s)))

def birds(d,r,x,y,n=12,stroke=(31,41,48)):
 for _ in range(n):
  xx=x+r.randrange(-120,120);yy=y+r.randrange(-65,65);ss=r.randrange(3,10)
  d.arc((xx-ss,yy-ss,xx,yy+ss),200,345,fill=stroke,width=2)
  d.arc((xx,yy-ss,xx+ss,yy+ss),195,338,fill=stroke,width=2)

def lantern(d,x,y,s,pal):
 c=light(pal[2],.1)
 d.line((x,y-130*s,x,y-12*s),fill=dark(pal[0],.35),width=max(2,int(7*s)))
 d.polygon([(x-14*s,y-133*s),(x+14*s,y-133*s),(x+11*s,y-101*s),(x-11*s,y-101*s)],fill=c)
 d.rectangle((x-13*s,y-135*s,x+13*s,y-131*s),fill=dark(pal[0],.35))

def moon(d,r,x=360,y=125,rad=47,full=False):
 circle(d,x,y,rad,(248,220,166))
 if not full:circle(d,x+rad*.33,y-rad*.2,rad*.84,(33,54,76))

def arch(d,x,y,s,pal):
 col=dark(pal[0],.3)
 d.rectangle((x-95*s,y-182*s,x-65*s,y),fill=col)
 d.rectangle((x+65*s,y-182*s,x+95*s,y),fill=col)
 d.rectangle((x-95*s,y-205*s,x+95*s,y-176*s),fill=col)
 d.arc((x-70*s,y-242*s,x+70*s,y-105*s),180,360,fill=light(pal[2],.22),width=max(2,int(7*s)))

# All scenes contain foreground, middle distance, light, and subject-related motifs.
def scenery(im,r,pal,motif,gen):
 layer=Image.new('RGBA',(W,H),(0,0,0,0));d=ImageDraw.Draw(layer)
 top,mid,bot=pal
 if motif in ('sky','tech') or (gen=='fantasy' and r.random()<.38):stars(d,r,n=130)
 elif gen in ('romance','child','psych') and r.random()<.35:clouds(d,r,n=7)
 if motif in ('garden','forest','growth','child','bird'):
  hills(d,r,pal,base=370)
  if motif=='garden':
   for k in range(7):tree(d,r,40+k*82+r.randrange(-25,25),520,r.uniform(.42,1.1),pal,True)
   for _ in range(65):
    x,y=r.randrange(W),r.randrange(375,510);rr=r.randint(3,9);circle(d,x,y,rr,r.choice([(238,173,149),(253,219,133),(192,112,125),(234,198,198)]))
   person(d,238,474,.9, (86,55,75),r=r)
  elif motif=='forest':
   for k in range(11):tree(d,r,-20+k*54,520,r.uniform(.6,1.45),pal,True)
   person(d,231,480,.85,(174,106,72),r=r,cloak=True)
  elif motif=='bird':
   tree(d,r,85,505,1.4,pal)
   birds(d,r,300,158,22,dark(pal[0],.3))
   person(d,370,488,1.05,dark(pal[0],.07),r=r)
  elif motif=='growth':
   tree(d,r,240,520,1.55,pal,True)
   for _ in range(35):
    x=r.randrange(W);circle(d,x,r.randrange(350,510),r.randrange(3,8),light(pal[2],.36))
  else:
   tree(d,r,400,530,.8,pal)
   person(d,145,479,.94, (194,118,101),r=r)
   circle(d,300,166,50,light(pal[2],.38))
 if motif in ('mountain','desert','train'):
  if motif=='desert':
   circle(d,330,155,81,light(bot,.37));
   for k in range(4):
    y=330+k*62
    d.polygon([(-5,y+60),(W,y+95),(W,y-35), (r.randint(170,320),y-48),(-5,y+18)],fill=blend(mid,bot,k*.13))
   for x,s in [(150,.75),(350,.56)]:
    d.polygon([(x-52*s,411),(x,290*s+70),(x+63*s,411)],fill=dark(top,.2))
   person(d,233,481,.9, dark(top,.1),r=r,cloak=True)
  else:
   for k in range(5):
    yy=250+k*49;col=blend(mid,dark(top,.5),k/4)
    for xx in range(-80,650,115):
     peak=r.randrange(85,180)
     d.polygon([(xx-125,yy+peak*.5),(xx+45,yy-peak),(xx+180,yy+peak*.65)],fill=col)
   if motif=='mountain':
    person(d,268,480,1.1,(40,62,69),r=r,cloak=True)
    birds(d,r,250,158,10,dark(top,.2))
   else:
    d.polygon([(208,470),(270,470),(440,550),(40,550)],fill=dark(top,.5))
    d.line([(208,470),(40,550)],fill=light(bot,.3),width=4)
    d.line([(270,470),(440,550)],fill=light(bot,.3),width=4)
    for y in range(475,547,9):d.line((230-(y-470)*2, y, 251+(y-470)*2,y),fill=dark(top,.1),width=3)
    person(d,370,460,.72,(68,78,77),r=r)
 if motif in ('sea','rain'):
  water(d,r,pal)
  if motif=='sea':
   d.polygon([(190,387),(355,387),(337,414),(212,414)],fill=dark(top,.5))
   d.line((265,200,265,387),fill=dark(top,.8),width=5)
   d.polygon([(272,214),(272,380),(352,365)],fill=light(bot,.53))
   d.polygon([(255,235),(255,369),(198,360)],fill=light(bot,.12))
   birds(d,r,120,170,10,dark(top,.33))
  else:
   for k in range(60):
    x=r.randrange(W);y=r.randrange(65,450)
    d.line((x,y,x-8,y+22),fill=rgba(light(pal[1],.3),r.randrange(80,190)),width=1)
   lantern(d,110,480,1.2,pal);person(d,300,480,1.1,dark(pal[0],.2),r=r,cloak=True)
 if motif in ('castle','temple'):
  hills(d,r,pal,base=400,n=3)
  circle(d,355,125,58,light(bot,.55))
  if motif=='castle':castle(d,238,460,1.1,pal)
  else:
   for x in [85,149,213,277,341]:
    d.rectangle((x,286,x+31,469),fill=dark(mid,.43))
    d.rectangle((x-10,278,x+41,293),fill=light(bot,.05))
   d.polygon([(45,275),(240,190),(407,275)],fill=dark(top,.2))
   d.rectangle((44,468,407,485),fill=dark(top,.6))
   person(d,220,478,.8,(102,89,110),r=r)
 if motif in ('city','noir','house'):
  for k in range(24):
   x=k*25-10;hh=r.randrange(110,265)
   col=dark(top,r.uniform(.1,.55));d.rectangle((x,478-hh,x+22,480),fill=col)
   for yy in range(478-hh+15,463,22):
    if r.random()<.5: d.rectangle((x+8,yy,x+12,yy+9),fill=light(bot,.2))
  if motif=='house':house(d,255,492,1.2,pal,True)
  else:
   d.polygon([(0,475),(480,475),(480,534),(0,534)],fill=dark(top,.45))
   lantern(d,96,477,1.1,pal)
   person(d,350,494,1.1,(30,36,46) if motif=='noir' else (88,55,65),r=r,cloak=True)
   if motif=='noir':
    d.ellipse((335,416,364,425),fill=dark(top,.8))
    for k in range(36):
     x=r.randrange(W);y=r.randrange(120,470);d.line((x,y,x-6,y+17),fill=rgba((190,197,196),105))
 if motif=='heart':
  hills(d,r,pal,base=435,n=2);tree(d,r,75,495,1.45,pal)
  person(d,215,486,1.18,(88,61,80),r=r)
  person(d,270,490,1.10,(189,122,117),r=r)
  birds(d,r,315,171,10,dark(top,.2))
 if motif in ('library','clock','music','coffee'):
  # Lit Victorian interior with window, shelves, books, or instrument.
  d.rectangle((30,96,450,500),fill=dark(mid,.30),outline=light(bot,.17),width=5)
  d.rectangle((77,104,398,336),fill=light(mid,.42),outline=light(bot,.37),width=9)
  d.line((238,104,238,336),fill=dark(top,.23),width=12)
  d.line((77,218,398,218),fill=dark(top,.23),width=11)
  d.polygon([(45,475),(435,475),(480,550),(0,550)],fill=dark(top,.56))
  if motif=='clock':
   circle(d,240,223,91,light(bot,.24),outline=dark(top,.3),width=10)
   for k in range(12):
    an=k*math.pi/6
    x=240+74*math.sin(an);y=223-74*math.cos(an)
    circle(d,x,y,3,dark(top,.3))
   d.line((240,223,241,170),fill=dark(top,.34),width=6)
   d.line((240,223,293,232),fill=dark(top,.34),width=5)
  elif motif=='music':
   d.rectangle((112,366,364,443),fill=dark(top,.7),outline=light(bot,.08),width=5)
   for j in range(19):
    x=122+j*12
    d.rectangle((x,372,x+10,426),fill=(238,219,182))
    if j%5 in (0,1,3):d.rectangle((x+6,373,x+14,401),fill=(26,33,40))
   for _ in range(15):
    x=r.randrange(W);y=r.randrange(110,265);circle(d,x,y,r.randrange(2,6),light(bot,.4))
  else:
   for k in range(8):
    x=65+k*45;d.rectangle((x,358,x+32,440),fill=r.choice([(125,71,67),(55,93,91),(160,124,88),(69,59,81)]),outline=light(bot,.1),width=2)
   if motif=='coffee':
    d.ellipse((185,420,325,439),fill=(234,213,177));d.rectangle((192,400,288,433),fill=light(bot,.35));d.arc((284,400,316,437),260,85,fill=light(bot,.45),width=6)
    for kk in range(4):d.arc((216+kk*14,362,230+kk*14,399),220,335,fill=rgba((237,224,202),120),width=2)
 if motif in ('sky','tech','lab','brain'):
  # technological and cosmic art gets deliberately figurative objects, not plain geometric placeholders
  stars(d,r,n=150)
  if motif=='sky':
   circle(d,260,285,125,light(mid,.35),outline=light(bot,.3),width=6)
   for k in range(8):
    yy=210+k*19;d.arc((148,yy,370,yy+73),10,170,fill=rgba(dark(top,.25),130),width=2)
   d.arc((58,180,445,425),12,198,fill=light(bot,.4),width=7)
   circle(d,100,140,24,light(bot,.45));hills(d,r,pal,base=458,n=2)
  elif motif=='tech':
   # circuit panel, luminous vertical server columns, abstract brain-like network
   for _ in range(44):
    x=r.randrange(22,458);y=r.randrange(95,448);x2=x+r.randrange(-75,76)
    d.line((x,y,x2,y),fill=rgba(light(bot,.55),150),width=2)
    d.line((x2,y,x2,y+r.randrange(-56,57)),fill=rgba(light(bot,.55),150),width=2)
    circle(d,x,y,3,light(bot,.2))
   d.ellipse((154,164,332,357),outline=light(bot,.26),width=9)
   for _ in range(26):
    x=r.randrange(176,320);y=r.randrange(190,343);circle(d,x,y,r.randrange(2,6),light(bot,.46))
  elif motif=='lab':
   # recognizable microscope and glass flasks with small luminous molecules.
   d.line((172,180,235,255),fill=light(bot,.3),width=18)
   d.line((218,247,267,352),fill=dark(top,.35),width=20)
   d.arc((174,245,343,396),0,180,fill=light(bot,.4),width=12)
   d.rectangle((131,405,351,423),fill=dark(top,.5))
   d.polygon([(334,300),(370,300),(395,391),(302,391)],fill=rgba(light(bot,.3),180))
   for _ in range(25):
    x,y=r.randrange(105,393),r.randrange(130,430);rr=r.randrange(3,10)
    circle(d,x,y,rr,light(mid,.55));
  else:
   # anatomical, connected network of synapses, head profile silhouette.
   d.ellipse((157,169,345,344),fill=dark(mid,.30),outline=light(bot,.33),width=8)
   d.polygon([(220,326),(316,310),(320,431),(194,432)],fill=dark(mid,.30))
   points=[]
   for _ in range(36):
    x=r.randrange(176,320);y=r.randrange(198,330);points.append((x,y))
   for (x,y),(xx,yy) in zip(points,points[1:]):d.line((x,y,xx,yy),fill=light(bot,.40),width=2)
   for x,y in points:circle(d,x,y,4,light(bot,.50))
 if motif in ('money','sports'):
  if motif=='sports':
   d.rectangle((0,381,480,519),fill=dark(mid,.33))
   for k in range(15):
    x=r.randrange(W);y=r.randrange(310,470);circle(d,x,y,r.randrange(2,5),light(bot,.33))
   circle(d,250,335,73,light(bot,.51),outline=dark(top,.55),width=5)
   for q in range(6):
    d.arc((190,286+q*8,313,381-q*7),10,170,fill=dark(top,.34),width=3)
   person(d,134,482,1.5,dark(top,.35),r=r)
  else:
   for k in range(14):
    x=k*37-18;h=r.randrange(70,258)
    col=dark(mid,.1+r.random()*.4);d.polygon([(x,478),(x,478-h),(x+29,478-h),(x+29,478)],fill=col)
    for y in range(492-h,466,17):d.rectangle((x+9,y,x+17,y+8),fill=light(bot,.30))
   d.polygon([(0,495),(480,495),(480,545),(0,545)],fill=dark(top,.35))
   d.line((45,418,144,353,225,368,329,250,420,200),fill=light(bot,.40),width=6,joint='curve')
 if motif=='fire':
  hills(d,r,pal,base=405,n=2)
  for k in range(25):
   x=r.randrange(W);y=r.randrange(325,500)
   d.polygon([(x-15,y+30),(x+6,y-r.randrange(20,95)),(x+22,y+32)],fill=rgba(r.choice([(235,116,57),(253,183,78),(201,77,56)]),190))
  person(d,244,480,1.15,(29,30,36),r=r,cloak=True)
 if motif=='kite':
  hills(d,r,pal,base=445,n=3)
  # The flying kite is a direct literary subject, its ribbon and string visible in the evening sky.
  d.polygon([(307,126),(365,195),(307,267),(249,195)],fill=(193,63,64),outline=light(bot,.45),width=4)
  d.line((307,126,307,267),fill=light(bot,.3),width=2)
  d.line((249,195,365,195),fill=light(bot,.3),width=2)
  d.arc((160,235,400,565),150,270,fill=light(bot,.4),width=2)
  for k in range(7):
   x=306+r.randrange(-26,28);y=268+k*21
   d.polygon([(x,y),(x-9,y+11),(x+9,y+11)],fill=r.choice([(201,106,79),(232,188,116),(119,179,165)]))
  person(d,120,488,1.12,(46,58,74),r=r)
  person(d,175,491,.78,(153,110,80),r=r)
 if motif=='portrait':
  # Illustrated bust profile, shoulders and hair, rather than an abstract icon.
  d.ellipse((100,96,380,441),fill=dark(mid,.20),outline=light(bot,.34),width=9)
  d.polygon([(91,455),(121,340),(175,292),(289,288),(348,385),(411,472)],fill=dark(top,.22))
  d.ellipse((160,151,311,320),fill=(183,135,108))
  d.polygon([(148,174),(151,125),(181,103),(275,120),(317,159),(291,184),(276,163),(223,144),(179,195)],fill=dark(top,.39))
  d.ellipse((263,229,283,234),fill=(20,30,39))
  d.arc((241,262,289,293),15,135,fill=(132,59,67),width=4)
  d.polygon([(180,321),(289,321),(340,445),(129,445)],fill=dark(top,.24))
 if motif=='autumn':
  hills(d,r,pal,base=440,n=3)
  for k in range(7):tree(d,r,10+k*84,523,r.uniform(.6,1.2),pal,False)
  for k in range(210):
   x,y=r.randrange(W),r.randrange(110,515)
   clr=r.choice([(214,122,63),(241,176,91),(173,81,62),(241,197,97)])
   d.ellipse((x-4,y-3,x+6,y+3),fill=clr)
  person(d,245,483,1.0,(62,44,57),r=r,cloak=True)
 if motif=='clock':birds(d,r,410,115,5,dark(top,.2))
 if motif=='rain':circle(d,365,98,31,light(bot,.52))
 if motif=='house':tree(d,r,46,504,.7,pal)
 if motif=='garden':birds(d,r,366,152,9,dark(top,.2))
 if motif=='child':
  for i in range(6):
   x=50+i*76;d.ellipse((x,80+i*20,x+26,125+i*20),fill=r.choice([(239,180,157),(246,214,128),(158,213,216)]))
   d.line((x+13,125+i*20,x+25,270),fill=rgba(light(bot,.5),175),width=1)
 return Image.alpha_composite(im.convert('RGBA'),layer)

# Variation in cover typography, border treatments and illumination.
def latin(s):return bool(re.search(r'[A-Za-z]',s)) and not bool(re.search(r'[\u0600-\u06ff]',s))
def wrap_title(s,font,max_w=418,max_lines=4):
 words=s.split();lines=[];cur='';d=ImageDraw.Draw(Image.new('RGB',(8,8)))
 for word in words:
  cand=f'{cur} {word}'.strip()
  w=d.textbbox((0,0),cand,font=font,direction='ltr' if latin(s) else 'rtl')[2]
  if w<=max_w or not cur:cur=cand
  else:lines.append(cur);cur=word
 if cur:lines.append(cur)
 return lines

def fit_title(s):
 islat=latin(s)
 path=FE if islat else FB
 size=48 if islat else 52
 while size>=24:
  f=ImageFont.truetype(path,size)
  lines=wrap_title(s,f)
  if len(lines)<=3:return f,lines
  size-=2
 return ImageFont.truetype(path,23),wrap_title(s,ImageFont.truetype(path,23))

def cover(b):
 r=random.Random(seed(b));g=genre(b);pal=r.choice(PALETTES[g]);motif,provenance=theme_for(b,g,r)
 im=background(pal,r,motif)
 # Atmospheric diffuse light, scenes
 x=r.randrange(120,390);y=r.randrange(80,260)
 im=glow(im,x,y,r.randrange(22,75),light(pal[2],.3))
 im=scenery(im,r,pal,motif,g).convert('RGB')
 layer=Image.new('RGBA',(W,H),(0,0,0,0));d=ImageDraw.Draw(layer)
 # Classically illustrated dust jacket upper embellishment
 d.rectangle((14,14,W-15,H-15),outline=rgba(light(pal[2],.45),180),width=2)
 # Bottom literary title plaque smoothly obscures complex image while keeping scene visible above
 for y in range(419,632):
  t=min(1,max(0,(y-419)/124))
  d.line((20,y,460,y),fill=rgba(dark(pal[0],.66),int(135+115*t)),width=1)
 d.line((46,477,434,477),fill=rgba(light(pal[2],.43),215),width=2)
 d.line((46,611,434,611),fill=rgba(light(pal[2],.27),155),width=1)
 # Top-line category (no claim to be publisher artwork)
 label={
 'romance':'داستان و ادبیات', 'fantasy':'جهان‌های خیال', 'crime':'معما و راز',
 'horror':'تعلیق و وحشت', 'child':'قصه‌های رنگارنگ','science':'دانش و کشف',
 'business':'کسب‌وکار و اندیشه','psych':'ذهن و رشد', 'history':'تاریخ و فلسفه',
 'poetry':'شعر و ادب','lifestyle':'زندگی و مهارت'}[g]
 small=ImageFont.truetype(FM,18)
 d.text((240,38),label,font=small,fill=rgba(light(pal[2],.8),235),anchor='mm',direction='rtl')
 if r.random()<.6:
  d.line((55,63,155,63),fill=rgba(light(pal[2],.35),120),width=1)
  d.line((325,63,425,63),fill=rgba(light(pal[2],.35),120),width=1)
 title=b['title'].strip();font,lines=fit_title(title)
 islat=latin(title)
 if islat and len(lines)>3:
  lines=lines[:3];lines[-1]=lines[-1][:28]+'…'
 line_h=int(font.size*(1.25 if islat else 1.41))
 block_h=len(lines)*line_h
 ystart=537-block_h//2
 # shadow and gold-white outline naturally visible on gradient
 for j,t in enumerate(lines):
  ypos=ystart+j*line_h
  direction='ltr' if islat else 'rtl'
  d.text((242,ypos+2),t,font=font,anchor='mm',direction=direction,fill=(7,15,20,230),stroke_width=2,stroke_fill=(7,15,20,185))
  d.text((240,ypos),t,font=font,anchor='mm',direction=direction,fill=rgba((248,229,197),255))
 author=(b.get('author') or '').strip()
 if author:
  if len(author)>48:author=author[:45]+'…'
  af=ImageFont.truetype(FER if latin(author) else FM,20)
  d.text((240,592),author,font=af,anchor='mm',direction='ltr' if latin(author) else 'rtl',fill=rgba((232,220,197),240))
 # Mini official disclaimer, external metadata rather than publisher claims
 d.rectangle((20,630,460,661),fill=rgba((9,28,35),240))
 foot=ImageFont.truetype(FM,13)
 d.text((240,645),'تصویرسازی مفهومی ورق  •  نه جلد رسمی ناشر',font=foot,anchor='mm',direction='rtl',fill=(223,208,177,255))
 im=Image.alpha_composite(im.convert('RGBA'),layer).convert('RGB')
 return im,motif,provenance,g

def run(limit=None):
 todo=BOOKS[20:20+limit] if limit else BOOKS[20:]
 log=[];start=time.time()
 for k,b in enumerate(todo):
  i=b['id'];name=f'book-{i:03d}.webp'
  if (OUT/name).is_file() and (THUMB/name).is_file():
   rr=random.Random(seed(b));gg=genre(b);mot,src=theme_for(b,gg,rr)
   log.append({'id':i,'title':b['title'],'category':b.get('category'),'motif':mot,'motif_source':src,'original_concept_cover':True})
   continue
  im,motif,prov,g=cover(b)
  i=b['id'];filename=f'book-{i:03d}.webp'
  im.save(OUT/filename,format='WEBP',quality=86,method=3)
  im.resize((240,336),Image.Resampling.LANCZOS).save(THUMB/filename,format='WEBP',quality=83,method=3)
  log.append({'id':i,'title':b['title'],'category':b.get('category'),'motif':motif,'motif_source':prov,'original_concept_cover':True})
  if (k+1)%100==0:print('RENDER',k+1,'elapsed',round(time.time()-start,1),flush=True)
 print('DONE',len(todo), 'elapsed',round(time.time()-start,1),flush=True)
 return log
if __name__=='__main__':
 limit=int(sys.argv[1]) if len(sys.argv)>1 else None
 logs=run(limit)
 (ROOT/'data/COVER_SCENE_INDEX_V983.json').write_text(json.dumps(logs,ensure_ascii=False,indent=2),encoding='utf-8')
