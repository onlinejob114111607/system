// ============================================================
//  القيم الافتراضية لمتابعة المسجلين (نفس الملف بالموقع: web/src/funnelDefaults.js)
//  النصوص حسب نص الرسائل المعتمد
// ============================================================

// waitFor: شو لازم يرد العميل حتى ننتقل للخطوة اللي بعدها
//   any    = أي رد (إلا الرفض)
//   accept = رد فيه قبول (تمام، جاهز، أكيد...)
//   image  = صورة (لقطة شاشة)
//   none   = ما بنستنى، بنكمل للخطوة الجاية مباشرة
// rejectStops: لو false، كلمة "لا" بهالخطوة ما بتوقف المتابعة (بتطلعلك "محتاج ردك")
export const FUNNEL_STEPS = [
  {
    key: 'welcome',
    label: 'مسج تعريفي',
    waitFor: 'any',
    rejectStops: true,
    resume: '',
    voice: 'welcome',
    messages: ['مرحباً {name}\nكيف حالك؟\nمعك {اسمي}\nحضرتك تركت تفاصيلك عبر السوشال ميديا بخصوص عمل إضافي تسويق الكتروني..\nصحيح؟'],
  },
  {
    key: 'book',
    label: 'مسج بوك 1 + بوك 2',
    waitFor: 'accept',
    rejectStops: true,
    resume: 'إذا جاهز للحضور على الموعد ابعتلي كلمة *جاهز* 👍',
    voice: 'book',
    messages: [
      'مشروعنا يعمل في أكثر من 40 دولة وحالياً بنأسس فريق عمل يعمل بشكل جزئي او كامل .\n\nجزء من عملنا التسويق عبر الانترنت من خلال نظام عمل فعال ومجرب على وسائل التواصل الاجتماعي.\n\nإذا إنت *مهتم* بالفرصة، وتكون جزء من فريق العمل يجب عليك التعرف على المعلومات الأساسية عن *طبيعة العمل* من خلال لقاء تعريفي أونلاين عبر برنامج زوم\n\nبعد اللقاء إذا شفت نفسك شخص مناسب رح تمر معنا بتدريبات وسيتم العمل معك خطوة بخطوة حتى تضمن نجاحك معنا\n\n- *موعد اللقاء*\n- *يوم {يوم} {تاريخ}*\n- *الساعة {ساعة_دبي} مساءً بتوقيت دبي*\n- مدة اللقاء *{المدة} دقيقة*',
      '*ملاحظة*\n- *العدد المطلوب محدود جدا*\n- *اللقاء مغلق الكاميرات*\n- إذا جاهز للحضور على الموعد\nارسلي كلمة *جاهز*\nليتم استكمال خطوات الحجز وارسلك رابط التسجيل للقاء\n- *اذا عندك احتمال لو واحد بالمية ما تكون معنا باللقاء، ياريت تخبرني عشان ما اضيع الفرصة على غيرك*.\n\n*يومك سعيد*',
    ],
  },
  {
    key: 'register',
    label: 'رابط التسجيل ولقطة الشاشة',
    waitFor: 'image',
    rejectStops: true,
    disclose: true,
    resume: 'بانتظار لقطة شاشة من إيميل التأكيد اللي بيوصلك بعد التسجيل 📸',
    messages: [
      'يكون موعد اللقاء الأول عبر الإنترنت يوم {يوم} الموافق {تاريخ}\n*{ساعة_دبي}* مساءً بتوقيت دبي.\nمهم جدا تسجيل معلوماتك الآن, أي خطأ بالايميل لن يصلك الرابط.\n{رابط}\nالرقم المرجعي: {رقم}\nبعد التسجيل سيصلك إيميل تأكيد تسجيلك, *أرسل لي لقطة شاشة من الايميل الي وصلك*',
    ],
  },
  {
    key: 'trainer',
    label: 'متابعة المدرب الدولي',
    waitFor: 'accept',
    rejectStops: false,
    resume: 'هل قمت بمتابعة المدرب الدولي؟ 🙂',
    messages: ['هل قمت بمتابعه المدرب الدولي حتى تتعرف عليه شخصيا قبل دخول اللقاء ؟؟'],
  },
  {
    key: 'final',
    label: 'انتظار رابط اللقاء + روابط الزوم',
    waitFor: 'none',
    rejectStops: true,
    voice: 'final',
    messages: [
      'تمام الان بضل عليك تستنى *يوصلك رابط اللقاء من الشركة ع ايميلك* قبل اللقاء بنص ساعه',
      '*ملاحظات مهمة*\n- ضع منبه ليذكرك بموعد اللقاء\n- اللقاء سيكون عبر تطبيق الاتصال *zoom*\n\nرابط تحميل تطبيق الزووم للاندرويد..\nhttps://play.google.com/store/apps/details?id=us.zoom.videomeetings\n\nرابط تحميل تطبيق الزووم للأيفون..\nhttps://apps.apple.com/jo/app/zoom-cloud-meetings/id546505307',
    ],
  },
]

// رسائل بتنبعت تلقائياً للي خلّصوا التسجيل (البوك) يوم اللقاء — before = كم دقيقة قبل اللقاء
// who: all = الكل · early = بوك بكير بس (من اليوم اللي قبل أو الصبح) · silent = اللي ما رد ولا شاف من آخر تذكير
// kind: msg = رسالة للشخص · list = قائمة تيليجرام إلك (اللي ما بعتوا لقطة)
// voice: فويس بينبعت بعد الرسالة (أو بدالها لو الرسالة فاضية)
// لو حدا خلّص متأخر، بيوصله بس أقرب تذكير، مش كل اللي فاتوا
export const FUNNEL_REMINDERS = [
  {
    key: 'confirm',
    label: 'تذكير العصر (كونفيرم)',
    before: 180,
    enabled: true,
    who: 'early',
    kind: 'msg',
    voice: '',
    messages: [
      'يعطيك العافية {name}\nموعدك معنا على البث الساعة {ساعة_دبي} بتوقيت دبي..\n- مهم جداً مراعاة فرق التوقيت بين مكان إقامتك ومدينة دبي.\n- مهم جداً تكون بمكان هادئ للتركيز في معلومات البث.\n- مع ورقه وقلم وسماعات وتركيز كامل لتاخد ملاحظات.\n- إذا عندك إحتمال 1% ما تكون معنا على الموعد خبرني الآن لحتى اعطي الفرصة لشخص اخر .\n*ملاحظة رقمك المرجعي {رقم}*',
    ],
  },
  {
    key: 'hour',
    label: 'قبل ساعة (للكل)',
    before: 60,
    enabled: true,
    who: 'all',
    kind: 'msg',
    voice: '',
    messages: [
      'مرحبا\nسيتم بث اللقاء مباشرة عن طريق اليوتيوب او تطبيق زوم\nيوجد عدد محدود ادخل قبل فوات الأوان.\n- سيتم ارسال رابط الزوم خلال نصف ساعة إلى الايميل (الجيميل) الذي قمت بالتسجيل من خلاله\n- اذا وصلك رابط اللقاء ابعت كلمة *تم* ,\n- اذا لم يصلك رابط اللقاء خلال نصف ساعة ابعت *لم يصل*\n*ملاحظة رقمك المرجعي {رقم}*',
    ],
  },
  {
    key: 'ping',
    label: 'فحص التفاعل: فويس للي ما رد ولا شاف',
    before: 30,
    enabled: true,
    who: 'silent',
    kind: 'msg',
    voice: 'ping',
    messages: ['{name} وصلك رابط الزوم عالإيميل؟ 🙂'],
  },
  {
    key: 'join',
    label: 'ادخل اللقاء وابعت لقطة شاشة',
    before: 18,
    enabled: true,
    who: 'all',
    kind: 'msg',
    voice: '',
    messages: ['{name} اللقاء رح يبدأ كمان شوي ⏰\nادخل هلأ من رابط الزوم اللي وصلك عالإيميل، وابعتلي *لقطة شاشة* أول ما تدخل للتأكد إنك دخلت الرابط الصحيح 📸'],
  },
  {
    key: 'list',
    label: 'قائمة تيليجرام باللي ما بعتوا لقطة',
    before: 8,
    enabled: true,
    who: 'all',
    kind: 'list',
    voice: '',
    messages: [],
  },
]

// أي صورة بتوصل من وقت "ادخل اللقاء" لحد آخر اللقاء = تأكيد حضور مبدئي، وبيوصله هالرد مرة وحدة
export const JOIN_ACK = 'ممتاز {name} 👌 أهلاً فيك باللقاء، ركّز معنا للآخر وخذ ملاحظاتك ✍️'

// متابعة اللي ما حضر: دعوة وحدة بس للقاء الجاي، وبعدها البوت بيوقف معه
export const NOSHOW_TEXT =
  'مرحبا {name} 🌸\nشكلك ما لحقت تحضر اللقاء الماضي.\nفي لقاء جديد يوم *{يوم} {تاريخ}* الساعة *{ساعة_دبي}* بتوقيت دبي (يعني *{ساعة_محلي}* بتوقيتك).\nحابب أحجزلك مكان؟'

// رسالة الوضوح: بتنبعت قبل رابط التسجيل (لو مفعّلة من الإعدادات)
export const DISCLOSURE_TEXT =
  'قبل ما أبعتلك رابط التسجيل، حابب أكون واضح معك 🤝\n- الشركة اسمها *bHIP* (www.bhipglobal.com) ومقرها تكساس بأمريكا، ومجالها منتجات الصحة والعافية.\n- طبيعة العمل *تسويق شبكي*: بتسوّق منتجات الشركة وبتبني فريق، والدخل عمولات حسب المبيعات، *ومافي راتب ثابت*.\n- *التكلفة الكاملة*: {التكلفة}\n- اللقاء نفسه مجاني، وبعده إنت بتقرر تكمل أو لا بدون أي التزام.'

// رد تلقائي على أسئلة معروفة (بيرد وبيكمل من مكانه، بدل ما يوقف ويستناك)
// key "time" = سؤال موعد اللقاء: بيرد بالتوقيت المحلي حسب دولة الشخص (من رقمه)
export const AUTO_ANSWERS = [
  {
    key: 'time',
    label: 'موعد اللقاء',
    enabled: true,
    resume: false,
    words: ['الساعه كم', 'ساعه كم', 'كم الساعه', 'اي ساعه', 'ايش ساعه', 'قديش الساعه', 'الساعه قديش', 'وقتيش', 'متى اللقاء', 'امتى اللقاء', 'ايمتى اللقاء', 'متى الموعد', 'امتى الموعد', 'موعد اللقاء', 'وقت اللقاء', 'شو الموعد', 'ايش الموعد', 'متى البث', 'الموعد', 'what time'],
    text: 'موعد اللقاء يوم *{يوم} {تاريخ}*\nالساعة *{ساعة_دبي}* بتوقيت دبي، يعني الساعة *{ساعة_محلي}* بتوقيتك ({بلدك}) 🕖\nبتكون جاهز؟',
  },
  {
    key: 'salary',
    label: 'الراتب والدخل',
    enabled: true,
    resume: true,
    words: ['راتب', 'الراتب', 'معاش', 'المعاش', 'كم بربح', 'كم الربح', 'قديش بربح', 'كم بطلع', 'قديش بطلع', 'الدخل', 'كم الدخل', 'كم بعمل مصاري', 'المردود', 'الارباح', 'كم الارباح', 'salary'],
    text: 'بكل وضوح: *ما في راتب ثابت* 🙏\nالشغل مع شركة *bHIP* بنظام التسويق الشبكي، والدخل عمولات حسب مبيعاتك ومبيعات فريقك، فبيختلف كتير من شخص لشخص، وفي ناس ما بيحققوا دخل بالبداية.\nالتكلفة الكاملة: {التكلفة}',
  },
  {
    key: 'cost',
    label: 'التكلفة والرسوم',
    enabled: true,
    resume: true,
    words: ['التكلفه', 'تكلفه', 'الرسوم', 'رسوم', 'بدفع', 'لازم ادفع', 'ادفع', 'الدفع', 'اشتراك', 'الاشتراك', 'مجاني', 'ببلاش', 'كم السعر', 'بكم', 'فلوس'],
    text: 'اللقاء نفسه *مجاني* 👍\nإذا قررت تكمل بعده، *التكلفة الكاملة*: {التكلفة}\nوما في أي التزام قبل ما تقرر.',
  },
  {
    key: 'company',
    label: 'الشركة وطبيعة العمل',
    enabled: true,
    resume: true,
    words: ['هرمي', 'شبكي', 'تسويق شبكي', 'اسم الشركه', 'شو الشركه', 'ايش الشركه', 'مين الشركه', 'شو الشغل', 'ايش الشغل', 'طبيعه العمل', 'نصب', 'احتيال', 'موثوق'],
    text: 'الشركة اسمها *bHIP* (www.bhipglobal.com) ومقرها تكساس بأمريكا، ومجالها منتجات الصحة والعافية.\nطبيعة العمل *تسويق شبكي*: بتسوّق المنتجات وبتبني فريق، والدخل من العمولات ومافي راتب ثابت.\nالتكلفة الكاملة: {التكلفة}',
  },
]

// خانات الفويسات (بترفعها من اللوحة)
export const VOICE_SLOTS = [
  ['welcome', 'بعد الترحيب'],
  ['book', 'عند الموعد (البوك)'],
  ['final', 'عند تأكيد الزووم'],
  ['ping', 'للي ما تفاعل قبل اللقاء'],
]

// جدول اللقاءات: لكل يوم وقته (بتوقيت دبي) — eve = البوك بيبدأ من الليلة اللي قبل
export const SCHEDULE = [
  { d: 1, time: '19:00', eve: true },
  { d: 3, time: '19:00', eve: true },
  { d: 4, time: '22:00', eve: false },
  { d: 5, time: '22:00', eve: false },
]

// في حال لم يتم الرد — بتنبعت مرة وحدة بس لكل شخص
export const NUDGE_TEXT = '{تحية}...\nيبدوا أنك غير مهتم...\n{name} هل مهتم بحضور اللقاء او اعطي مكانك لشخص اخر حتى يستفيد؟'

const ASK = '\n\nفهل انت من الاشخاص اللي حاب تنضم للدورة و تكون جزء من الفريق ؟'
// رسائل جاهزة للوحة (ما بتنبعت تلقائياً) — بعد اللقاء والأسئلة الخارجة عن النص
export const QUICK_REPLIES = [
  { label: 'بعد اللقاء: اللي بعت bit', text: 'تمام {name}\nهل عرفت كيف تسجل وتكمل دفع رسوم الدورة ؟' },
  { label: 'تحويل للتيم ليدر', text: 'اسمع {name}، راح احكي للتيم ليدر عنك " {التيم_ليدر} " حتى يجهزك للشغل مع المدرب الدولي بالدورة التدريبية.\nجاهز؟' },
  { label: 'بعد اللقاء: اللي ما بعت bit', text: 'مرحبا..\nهل شاهدت اللقاء للآخر ؟' },
  { label: 'المكان مناسب؟', text: 'هل بتشوف المكان مناسب الك تكمل و تكون قسم من فريق العمل ؟' },
  { label: 'عرفت تسجل وتدفع؟', text: 'هل عرفت كيف تسجل وتكمل دفع رسوم الدورة ؟' },
  { label: 'ما ركّز باللقاء', text: 'معناته ما ركزت باللقاء منيح او ما كملته للاخر صح ؟' },
  { label: 'هل انت جدي؟', text: 'تمام هل انت جدي بالنسبة للعمل معنا؟\nلانه ما بدي اضيع وقتي ووقتك، إذا لا خليني اعطي الفرصة لشخص آخر.' },
  { label: 'رابط الإعادة: التزام', text: 'إذا ببعتلك رابط الإعادة للقاء حتى تعيد اللي ما فهمته هسا، *هل راح تلتزم تحضره اكيد*' },
  { label: 'رابط الإعادة', text: '{رابط_الإعادة}\n\nتمام هاد الرابط رح يسكر في أي لحظه لهيك انا متاح فقط لساعه حتى اساعدك تكمل معنا' },
  { label: 'ابحث Torino', text: 'تمام في ايميلك اكتب بالبحث Torino\nستظهر لك رسالة تأكيد\nارسل لي لقطة شاشة' },
  { label: 'س: وين مقر الشركة؟', text: 'المقر الوحيد بالشركة تكسس امريكا .\nرابط الشركة www.bhipglobal.com' + ASK },
  { label: 'س: كم مدة الدورة؟', text: 'اسبوع .' + ASK },
  { label: 'س: هل رح اشتغل فوراً؟', text: 'انذكر باللقاء انه بعد الدورة بصير عندك إمكانية تحصل ع وكالة وتبلش شغل معنا.' + ASK },
  { label: 'س: كم بتعمل مصاري؟', text: 'بكل وضوح: ما في راتب ثابت. الشغل مع bHIP بنظام التسويق الشبكي، والدخل عمولات حسب مبيعاتك ومبيعات فريقك، وبيختلف كتير من شخص لشخص، وفي ناس ما بيحققوا دخل بالبداية.\nالتكلفة الكاملة: {التكلفة}' + ASK },
  { label: 'س: هرمي او شبكي؟', text: 'تسويق شبكي مع شركة bHIP (منتجات صحة وعافية): بتسوّق المنتجات وبتبني فريق، والدخل من عمولات المبيعات، ومافي راتب ثابت.\nالتكلفة الكاملة: {التكلفة}' + ASK },
  { label: 'س: شو المنتجات؟', text: 'مجال الشركة الصحة والعافية وراح تتعرف عليها من خلال الدورة .' + ASK },
  { label: 'س: ال 20 دولار من أرباحي؟', text: 'أيوه، هاي سياسة الشركة وبتنخصم من الأرباح. التكلفة الكاملة: {التكلفة}' + ASK },
  { label: 'س: ليش ادفع؟', text: 'الرسوم هي تكلفة الانضمام والدورة التدريبية مع الفريق.\nالتكلفة الكاملة: {التكلفة}\nوإنت حر تقرر تكمل أو لا.' + ASK },
]

export const ACCEPT_WORDS = [
  'تمام', 'تم', 'تمت', 'جاهز', 'جاهزه', 'جاهزين', 'اكيد', 'بالتاكيد', 'طبعا', 'اه', 'اها', 'ايوه', 'ايوا', 'ايو', 'نعم', 'اجل',
  'صحيح', 'صح', 'مظبوط', 'مزبوط', 'تابعت', 'تابعته', 'تابعتو', 'عملت', 'عملتها',
  'اوك', 'اوكي', 'اوكيه', 'ok', 'okay', 'okey', 'yes', 'yeah', 'yep', 'مهتم', 'مهتمه', 'موافق', 'موافقه', 'يلا', 'يالا', 'ماشي',
  'حاضر', 'طيب', 'تفضل', 'تفضلي', 'كمل', 'كملي', 'اكمل', 'معك', 'معاك', 'سجلت', 'خلصت', 'اتفضل', 'جميل', 'ممتاز', 'حلو',
  'لا مانع', 'ما في مشكله', 'مافي مشكله', 'لا مشكله', 'مفيش مشكله', 'ولا يهمك',
  '👍', '👌', '❤', '🙏', '✅', '💯', '🌹',
]

export const REJECT_WORDS = [
  'لا', 'لأ', 'لاء', 'no', 'stop', 'مش مهتم', 'مش مهتمه', 'غير مهتم', 'غير مهتمه', 'مو مهتم', 'ما مهتم', 'مش حابب', 'مش حابه',
  'ما بدي', 'مابدي', 'مش عايز', 'مش عاوز', 'مش عايزه', 'لا شكرا', 'الغاء', 'الغي', 'احذفني', 'احذف رقمي', 'بلاش', 'ما بدي اشتغل',
]

// ردود على تذكيرات قبل اللقاء بتطلعلك "محتاج ردك"
export const PROBLEM_WORDS = ['لم يصل', 'ما وصل', 'ماوصل', 'ما وصلني', 'ماوصلني', 'مش واصل', 'ما اجا', 'ما اجاني', 'مش شغال', 'مشكله', 'ما زبط', 'ما ظبط', 'ما بيفتح', 'مش راضي', 'ما قدرت', 'ما عرفت', 'كيف']

// كلمات رفض "خفيفة": بالخطوات اللي "لا" فيها مش رفض (سؤال المدرب، بعد البوك) بتطلعلك بدل ما توقف
export const SOFT_REJECT = ['لا', 'لأ', 'لاء', 'no', 'لا ما', 'لسا']

// نسخة النصوص: أقدم من 2 ← النصوص بترجع للأصل. 2 ← 3: بتنضاف الميزات الجديدة وبيضل كلامك زي ما هو
export const TEXTS_VER = 3
const QR_V3 = ['س: كم بتعمل مصاري؟', 'س: هرمي او شبكي؟', 'س: ال 20 دولار من أرباحي؟', 'س: ليش ادفع؟']

export const FUNNEL_DEFAULTS = {
  textsVer: TEXTS_VER,
  enabled: false,
  accountId: '', // فاضي = حساب الترحيب الافتراضي من الإعدادات العامة
  schedule: SCHEDULE, // أيام اللقاء ووقت كل يوم (دبي)
  days: SCHEDULE.map((x) => x.d), // (مشتقة من الجدول)
  meetingTime: '19:00', // الوقت الافتراضي لأي يوم جديد
  startTime: '08:00', // بداية المتابعة يوم اللقاء (توقيت مصر)
  lateUntil: '15:00', // المسجلين يوم اللقاء بيدخلوا دفعة اليوم لحد هالساعة (لو في مكان)
  closeTime: '23:59', // بعدها بتتسكر متابعة اليوم ولا بينبعت إشي
  eveStart: '20:00', // الليلة اللي قبل (للأيام المفعّل فيها) — بداية البوك
  eveEnd: '23:00', // وقف الإرسال بالليل لحد بداية اليوم
  earlyUntil: '12:00', // اللي بيخلّص البوك قبل هالساعة يوم اللقاء (أو من اليوم اللي قبل) = بوك بكير
  batchSize: 50, // كم شخص بكل لقاء (من الأقدم للأحدث)
  msgGap: 10, // ثواني بين الرسائل بنفس المحادثة
  clientGap: 20, // ثواني بين عميل وعميل
  debounce: 8, // ثواني بنستنى بعد آخر رسالة من العميل قبل ما نرد
  duration: 35,
  regLink: 'https://www.bhiptorino.com/event-details/',
  refNo: '114111607',
  senderName: 'أسامة', // {اسمي}
  teamLeader: 'أحمد', // {التيم_ليدر}
  replayLink: '', // {رابط_الإعادة}
  costText: '', // {التكلفة}
  discloseOn: false, // رسالة الوضوح قبل رابط التسجيل (لو مفعّلة، التكلفة إلزامية)
  disclosure: DISCLOSURE_TEXT,
  nudgeAfter: 120, // دقائق بدون رد قبل رسالة "في حال لم يتم الرد" (0 = مطفية)
  nudgeText: NUDGE_TEXT,
  manualStops: false, // ردك من الجوال بيوقف البوت؟ (لا = بيعتبره جواب وبيكمل)
  joinAck: JOIN_ACK,
  noShowOn: true,
  noShowText: NOSHOW_TEXT,
  autoAnswers: AUTO_ANSWERS,
  voiceOn: true,
  goal: { daily: 10, checks: [{ at: '13:00', pct: 40 }, { at: '17:00', pct: 75 }], rankName: '', rankLeft: 0, rankRight: 0 },
  acceptWords: ACCEPT_WORDS,
  rejectWords: REJECT_WORDS,
  problemWords: PROBLEM_WORDS,
  steps: FUNNEL_STEPS,
  reminders: FUNNEL_REMINDERS,
  quickReplies: QUICK_REPLIES,
}

const toList = (v, def) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\n,،]+/) : def).map((x) => String(x).trim()).filter(Boolean)
const hm = (v, def) => (/^\d{1,2}:\d{2}$/.test(String(v || '')) ? String(v).padStart(5, '0') : def)
const msgs = (v) => (Array.isArray(v) ? v : []).map((m) => String(m ?? '')).filter((m) => m.trim())
const STEP_DEF = Object.fromEntries(FUNNEL_STEPS.map((s) => [s.key, s]))
const REM_DEF = Object.fromEntries(FUNNEL_REMINDERS.map((r) => [r.key, r]))

// ترقية إعدادات النسخة 2 ← 3 (بدون ما نلمس نصوصك)
function upgrade2(d) {
  const x = { ...d }
  if (Array.isArray(d.steps))
    x.steps = d.steps.map((s) => {
      const def = STEP_DEF[s.key] || {}
      return { resume: def.resume || '', voice: def.voice || '', disclose: !!def.disclose, ...s }
    })
  if (Array.isArray(d.reminders)) {
    const old = Object.fromEntries(d.reminders.map((r) => [r.key, r]))
    x.reminders = FUNNEL_REMINDERS.map((def) => {
      const o = old[def.key]
      if (!o) return def
      return { ...def, enabled: o.enabled !== false, before: o.before ?? def.before, messages: o.messages?.length ? o.messages : def.messages }
    })
  }
  if (Array.isArray(d.quickReplies)) {
    const def = Object.fromEntries(QUICK_REPLIES.map((q) => [q.label, q]))
    x.quickReplies = d.quickReplies.map((q) => (QR_V3.includes(q.label) && def[q.label] ? def[q.label] : q))
  }
  if (d.meetingTime && !d.schedule && Array.isArray(d.days))
    x.schedule = d.days.map((n) => ({ ...(SCHEDULE.find((s) => s.d === Number(n)) || { d: Number(n), eve: false }), time: SCHEDULE.find((s) => s.d === Number(n))?.time || d.meetingTime }))
  return x
}

export function mergeFunnel(data) {
  let d = data || {}
  if (data && Number(data.textsVer) === 2) d = upgrade2(d)
  else if (data && data.textsVer !== TEXTS_VER) {
    const { steps, reminders, quickReplies, nudgeText, duration, ...rest } = d
    d = rest
  }
  const out = { ...FUNNEL_DEFAULTS, ...d, textsVer: TEXTS_VER }
  for (const k of ['batchSize', 'msgGap', 'clientGap', 'debounce', 'duration', 'nudgeAfter']) {
    const n = Number(out[k])
    out[k] = Number.isFinite(n) && n >= 0 ? n : FUNNEL_DEFAULTS[k]
  }
  out.batchSize = Math.max(1, Math.round(out.batchSize))
  out.msgGap = Math.max(3, out.msgGap)
  out.clientGap = Math.max(5, out.clientGap)
  out.debounce = Math.max(2, out.debounce)
  for (const k of ['startTime', 'lateUntil', 'closeTime', 'meetingTime', 'eveStart', 'eveEnd', 'earlyUntil']) out[k] = hm(out[k], FUNNEL_DEFAULTS[k])
  for (const k of ['regLink', 'refNo', 'senderName', 'teamLeader', 'replayLink', 'nudgeText', 'costText', 'disclosure', 'joinAck', 'noShowText']) out[k] = String(out[k] ?? '')
  if (!out.disclosure.trim()) out.disclosure = DISCLOSURE_TEXT
  out.manualStops = !!out.manualStops
  out.discloseOn = !!out.discloseOn
  out.noShowOn = out.noShowOn !== false
  out.voiceOn = out.voiceOn !== false
  // رسالة أولى مختلفة حسب مصدر التسجيل: { "فيسبوك": "نص..." }
  out.srcTemplates = Object.fromEntries(
    Object.entries(d.srcTemplates && typeof d.srcTemplates === 'object' ? d.srcTemplates : {})
      .map(([k, v]) => [String(k).trim(), String(v ?? '')])
      .filter(([k, v]) => k && v.trim()),
  )

  // الجدول: يوم واحد = سطر واحد
  const sch = Array.isArray(d.schedule) ? d.schedule : Array.isArray(d.days) && !d.schedule && data ? d.days.map((n) => ({ d: Number(n), time: out.meetingTime, eve: false })) : SCHEDULE
  const seen = new Set()
  out.schedule = sch
    .map((x) => ({ d: Number(x.d), time: hm(x.time, out.meetingTime), eve: !!x.eve }))
    .filter((x) => x.d >= 0 && x.d <= 6 && !seen.has(x.d) && seen.add(x.d))
    .sort((a, b) => a.d - b.d)
  out.days = out.schedule.map((x) => x.d)

  out.acceptWords = toList(d.acceptWords, ACCEPT_WORDS)
  out.rejectWords = toList(d.rejectWords, REJECT_WORDS)
  out.problemWords = toList(d.problemWords, PROBLEM_WORDS)
  const steps = Array.isArray(d.steps) && d.steps.length ? d.steps : FUNNEL_STEPS
  out.steps = steps.map((s, i) => ({
    key: s.key || `s${i}`,
    label: s.label || `خطوة ${i + 1}`,
    waitFor: ['any', 'accept', 'image', 'none'].includes(s.waitFor) ? s.waitFor : 'any',
    rejectStops: s.rejectStops !== false,
    resume: String(s.resume ?? ''),
    voice: String(s.voice ?? ''),
    disclose: !!s.disclose,
    messages: msgs(s.messages),
  }))
  // رسالة الوضوح إلزامية: لو ولا خطوة معلّمة، بتنحط عالخطوة اللي فيها رابط التسجيل
  if (!out.steps.some((s) => s.disclose)) {
    const i = out.steps.findIndex((s) => s.messages.some((m) => m.includes('{رابط}')))
    out.steps[i >= 0 ? i : Math.max(0, out.steps.length - 2)].disclose = true
  }
  const rems = Array.isArray(d.reminders) ? d.reminders : FUNNEL_REMINDERS
  out.reminders = rems.map((r, i) => ({
    key: r.key || `r${i}`,
    label: r.label || `تذكير ${i + 1}`,
    before: Math.max(0, Number(r.before) || 0),
    enabled: r.enabled !== false,
    who: ['all', 'early', 'silent'].includes(r.who) ? r.who : 'all',
    kind: r.kind === 'list' ? 'list' : 'msg',
    voice: String(r.voice || ''),
    messages: msgs(r.messages),
  }))
  const qr = Array.isArray(d.quickReplies) ? d.quickReplies : QUICK_REPLIES
  out.quickReplies = qr.map((q) => ({ label: String(q.label || '').trim(), text: String(q.text || '') })).filter((q) => q.label && q.text.trim())
  const aa = Array.isArray(d.autoAnswers) ? d.autoAnswers : AUTO_ANSWERS
  out.autoAnswers = aa
    .map((a, i) => ({
      key: String(a.key || `a${i}`),
      label: String(a.label || '').trim() || `رد ${i + 1}`,
      enabled: a.enabled !== false,
      resume: a.resume !== false,
      words: toList(a.words, []),
      text: String(a.text || ''),
    }))
    .filter((a) => a.text.trim() && a.words.length)
  const g = { ...FUNNEL_DEFAULTS.goal, ...(d.goal || {}) }
  out.goal = {
    daily: Math.max(0, Number(g.daily) || 0),
    checks: (Array.isArray(g.checks) ? g.checks : [])
      .map((c) => ({ at: hm(c.at, ''), pct: Math.min(100, Math.max(1, Number(c.pct) || 0)) }))
      .filter((c) => c.at && c.pct),
    rankName: String(g.rankName || ''),
    rankLeft: Math.max(0, Number(g.rankLeft) || 0),
    rankRight: Math.max(0, Number(g.rankRight) || 0),
  }
  return out
}

// وقت اللقاء ليوم معيّن (YYYY-MM-DD) حسب الجدول
export function meetingTimeOf(cfg, day) {
  const [y, m, dd] = String(day).split('-').map(Number)
  const wd = new Date(Date.UTC(y, m - 1, dd)).getUTCDay()
  return cfg.schedule.find((x) => x.d === wd)?.time || cfg.meetingTime
}
export function scheduleOf(cfg, day) {
  const [y, m, dd] = String(day).split('-').map(Number)
  const wd = new Date(Date.UTC(y, m - 1, dd)).getUTCDay()
  return cfg.schedule.find((x) => x.d === wd) || null
}

// ملخص يوم (للنسب): نفس الحساب بالعامل واللوحة
const HOUR_FMT = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', hour: '2-digit', hourCycle: 'h23' })
export const cairoHourOf = (msv) => String(Number(HOUR_FMT.format(new Date(Number(msv) || 0))) % 24)
export function srcOf(c) {
  return String(c.src || '').trim() || 'مباشر'
}
export function daySummary(rows) {
  const s = { welcomed: 0, replied: 0, booked: 0, attended: 0, rejected: 0, invited: 0, invBooked: 0, early: 0, late: 0, bySource: {}, byHour: {} }
  for (const c of rows) {
    const src = srcOf(c)
    const b = (s.bySource[src] ||= { welcomed: 0, booked: 0, attended: 0 })
    const welcomed = !c.reinvite && (c.step ?? -1) >= 0 && c.status !== 'failed'
    const booked = c.status === 'completed'
    const replied = (c.history || []).some((h) => h.d === 'in') || !!c.lastInAt
    if (c.reinvite) s.invited++
    if (welcomed) (s.welcomed++, b.welcomed++)
    if (replied) s.replied++
    // أفضل وقت للإرسال: ساعة المسج التعريفي (توقيت مصر) ← رد/بوك
    if (welcomed && c.welcomedAt) {
      const h = cairoHourOf(c.welcomedAt)
      const x = (s.byHour[h] ||= { w: 0, r: 0, b: 0 })
      x.w++
      if (replied) x.r++
      if (booked) x.b++
    }
    if (booked) {
      s.booked++
      b.booked++
      if (c.reinvite) s.invBooked++
      if (c.bookType === 'early') s.early++
      else s.late++
    }
    if (booked && c.attended) (s.attended++, b.attended++)
    if (c.status === 'rejected') s.rejected++
  }
  return s
}
export const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0)

// لو التكلفة مش مكتوبة: الأسطر اللي فيها {التكلفة} بتنشال من الرسالة
export const dropEmptyCost = (text, cfg) => (String(cfg.costText || '').trim() ? text : String(text).split('\n').filter((l) => !l.includes('{التكلفة}')).join('\n'))
