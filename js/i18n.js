const LAS_MAIN_I18N = {
  ar: {
    "page.title": "LAS CAFE — مقهى ومحمصة متخصصة",
    "nav.menu": "القائمة",
    "nav.search": "ابحث هنا",
    "nav.home": "الرئيسية",
    "nav.store": "تسوّق ONLINE",
    "nav.booking": "الحجز",
    "nav.catering": "الضيافة",
    "nav.locations": "الفروع",
    "nav.contact": "تواصل معنا",
    "branch.menu": "منيو - Menu",
    "branch.map": "الموقع - Location",
    "branch.phone": "الهاتف - Phone",
    "branch.whatsapp": "واتساب - Whatsapp",
    "branch.bonatTitle": "برنامج الولاء | Bonat",
    "branch.bonatCta": "بونات - Bonat",
    "lang.en": "EN",
    "lang.ar": "العربية",
    "hero.welcome": "مرحباً بكم في LAS CAFE",
    "hero.storeBtn": "متجر لاس",
    "hero.cta": "تسوّق هنا",
    "hero.prev": "السابق",
    "hero.next": "التالي",
    "portals.store.html": "تسوّق<br>ONLINE",
    "portals.booking.html": "احجز<br>&amp;<br>طاولتك",
    "portals.catering.html": "فعاليات<br>&amp;<br>الضيافة",
    "newsletter.title": "ابقَ على اطلاع",
    "newsletter.placeholder": "أدخل بريدك الإلكتروني",
    "newsletter.success": "شكراً! ستصلك رسائلنا قريباً.",
    "footer.tagline": "مقهى ومحمصة متخصصة",
    "footer.about": "من نحن",
    "footer.store": "تسوّق ONLINE",
    "footer.booking": "الحجز",
    "footer.catering": "الضيافة",
    "footer.locations": "الفروع",
    "footer.contact": "تواصل معنا",
    "footer.terms": "الشروط والأحكام",
    "terms.policies": "السياسات",
    "comingSoon": "قريبا",
  },
  en: {
    "page.title": "LAS CAFE — Specialty Cafe & Roastery",
    "nav.menu": "MENU",
    "nav.search": "Search Here",
    "nav.home": "Home",
    "nav.store": "Shop Online",
    "nav.booking": "Booking",
    "nav.catering": "Catering",
    "nav.locations": "Locations",
    "nav.contact": "Contact Us",
    "branch.menu": "Menu - منيو",
    "branch.map": "Location - الموقع",
    "branch.phone": "Phone - الهاتف",
    "branch.whatsapp": "Whatsapp - واتساب",
    "branch.bonatTitle": "Loyalty | Bonat",
    "branch.bonatCta": "Bonat - بونات",
    "lang.en": "EN",
    "lang.ar": "العربية",
    "hero.welcome": "Welcome to LAS CAFE",
    "hero.storeBtn": "LAS Store",
    "hero.cta": "SHOP HERE",
    "hero.prev": "PREVIOUS",
    "hero.next": "NEXT",
    "portals.store.html": "SHOP<br>ONLINE",
    "portals.booking.html": "BOOK<br>&amp;<br>TABLE",
    "portals.catering.html": "EVENTS<br>&amp;<br>CATERING",
    "newsletter.title": "Stay Updated",
    "newsletter.placeholder": "ENTER YOUR EMAIL",
    "newsletter.success": "Thanks! You'll hear from us soon.",
    "footer.tagline": "Specialty cafe & roastery",
    "footer.about": "About Us",
    "footer.store": "Shop Online",
    "footer.booking": "Booking",
    "footer.catering": "Catering",
    "footer.locations": "Locations",
    "footer.contact": "Contact Us",
    "footer.terms": "T&C's",
    "terms.policies": "Policies",
    "comingSoon": "Coming soon",
  },
};

const LAS_MAIN_LANG_KEY = "las-main-lang";

function getMainLang() {
  const saved = localStorage.getItem(LAS_MAIN_LANG_KEY);
  if (saved === "en" || saved === "ar") return saved;
  return "ar";
}

function setMainLang(lang) {
  localStorage.setItem(LAS_MAIN_LANG_KEY, lang);
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
  applyMainI18n(lang);
  document.dispatchEvent(new CustomEvent("las-main:languagechange", { detail: { lang } }));
}

function t(key, lang) {
  const l = lang || getMainLang();
  return LAS_MAIN_I18N[l]?.[key] ?? LAS_MAIN_I18N.en[key] ?? key;
}

function applyMainI18n(lang) {
  const l = lang || getMainLang();
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.getAttribute("data-i18n"), l);
  });
  document.querySelectorAll("[data-i18n-html]").forEach((el) => {
    el.innerHTML = t(el.getAttribute("data-i18n-html"), l);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.placeholder = t(el.getAttribute("data-i18n-placeholder"), l);
  });
  document.querySelectorAll("[data-i18n-aria]").forEach((el) => {
    el.setAttribute("aria-label", t(el.getAttribute("data-i18n-aria"), l));
  });
  const titleKey = document.body?.dataset?.pageTitle;
  if (titleKey) document.title = t(titleKey, l);
}

function initMainI18n() {
  setMainLang(getMainLang());
}

document.addEventListener("DOMContentLoaded", initMainI18n);
