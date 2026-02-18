/**
 * Site Configuration
 * ------------------
 * Centralized business information referenced by all components.
 * To spin up a new client site, change the values in this file.
 */

export const siteConfig = {
  businessName: "Starter Business",
  tagline: "Your Trusted Local Partner",
  phone: "(555) 123-4567",
  email: "info@starterbusiness.com",
  address: {
    street: "123 Main Street",
    city: "Cedar Rapids",
    state: "Iowa",
    zip: "52401",
  },
  socials: {
    facebook: "#",
    instagram: "#",
    google: "#",
  },
  services: [
    {
      title: "Residential Cleaning",
      slug: "service-one",
      description:
        "We'll make your home shine with our thorough, eco-friendly cleaning services. Regular maintenance or deep clean, we've got you covered.",
      icon: "wrench",
    },
    {
      title: "Property Maintenance",
      slug: "service-two",
      description:
        "Keep your property in peak condition year-round. From seasonal upkeep to preventive repairs, we handle the details so you don't have to.",
      icon: "chart",
    },
    {
      title: "Home Protection",
      slug: "service-three",
      description:
        "Comprehensive protection plans that safeguard your biggest investment. Inspections, monitoring, and rapid response when you need it most.",
      icon: "shield",
    },
  ],
};
