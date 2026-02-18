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
      title: "Service One",
      slug: "service-one",
      description:
        "Brief description of this service for the homepage card.",
      icon: "wrench",
    },
    {
      title: "Service Two",
      slug: "service-two",
      description:
        "Brief description of this service for the homepage card.",
      icon: "chart",
    },
    {
      title: "Service Three",
      slug: "service-three",
      description:
        "Brief description of this service for the homepage card.",
      icon: "shield",
    },
  ],
};
