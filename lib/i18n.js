// A deliberately small, honest i18n layer — covers the navigation, header,
// and footer UI strings only, not full page content (course descriptions,
// homepage body copy, blog posts, etc.). Translating those properly needs
// real translation work reviewed by a fluent speaker, not a quick automated
// pass on technical certification terminology where a wrong term could
// misstate what a course actually covers. This gives the language toggle a
// real, working effect rather than a button that does nothing, while being
// upfront about what it does and doesn't cover yet.
const STRINGS = {
  en: {
    nav_courses: "Courses", nav_corporate: "Corporate", nav_resources: "Resources",
    nav_blog: "Blog", nav_about: "About", nav_contact: "Contact",
    nav_login: "Log In", nav_account: "My Account",
    nav_search_placeholder: "Search courses...",
    footer_company: "Company", footer_about: "About Us", footer_contact: "Contact",
    footer_get_in_touch: "Get in touch",
  },
  de: {
    nav_courses: "Kurse", nav_corporate: "Unternehmen", nav_resources: "Ressourcen",
    nav_blog: "Blog", nav_about: "Über uns", nav_contact: "Kontakt",
    nav_login: "Anmelden", nav_account: "Mein Konto",
    nav_search_placeholder: "Kurse durchsuchen...",
    footer_company: "Unternehmen", footer_about: "Über uns", footer_contact: "Kontakt",
    footer_get_in_touch: "Kontaktieren Sie uns",
  },
};

function translator(lang) {
  const dict = STRINGS[lang] || STRINGS.en;
  return (key) => dict[key] || STRINGS.en[key] || key;
}

module.exports = { translator, SUPPORTED_LANGUAGES: Object.keys(STRINGS) };
