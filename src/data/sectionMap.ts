/**
 * Section-to-File Mapping
 * Maps data-section attribute values to their source file paths in the repo.
 * Used by the edit API to know which file to fetch and modify.
 *
 * Component sections live in dedicated files.
 * Page-inline sections (service pages, contact) live inside page files
 * and are resolved by the current page URL.
 */

/** Sections that are dedicated component files */
export const componentSections: Record<string, string> = {
  'navigation': 'src/components/sections/Navigation.astro',
  'hero': 'src/components/sections/Hero.astro',
  'services': 'src/components/sections/Services.astro',
  'about': 'src/components/sections/About.astro',
  'stats': 'src/components/sections/Stats.astro',
  'how-it-works': 'src/components/sections/HowItWorks.astro',
  'testimonials': 'src/components/sections/Testimonials.astro',
  'faq': 'src/components/sections/FAQ.astro',
  'cta-banner': 'src/components/sections/CTABanner.astro',
  'footer': 'src/components/sections/Footer.astro',
};

/** Sections that live inline inside page files */
const pageSections = new Set([
  'service-hero',
  'service-overview',
  'service-features',
  'service-process',
  'service-faq',
  'service-cta',
  'contact',
]);

/** Page URL pathname → source file path */
const pageFileMap: Record<string, string> = {
  '/services/service-one/': 'src/pages/services/service-one.astro',
  '/services/service-two/': 'src/pages/services/service-two.astro',
  '/services/service-three/': 'src/pages/services/service-three.astro',
  '/contact/': 'src/pages/contact.astro',
};

/**
 * Resolve a data-section value + current page URL to a source file path.
 * Returns null if the section can't be mapped.
 */
export function resolveFilePath(
  section: string,
  currentPage: string
): string | null {
  // Check dedicated component sections first
  if (componentSections[section]) {
    return componentSections[section];
  }

  // Check page-inline sections
  if (pageSections.has(section)) {
    // Normalize the page URL (ensure trailing slash)
    const normalized = currentPage.endsWith('/') ? currentPage : currentPage + '/';
    return pageFileMap[normalized] || null;
  }

  return null;
}
