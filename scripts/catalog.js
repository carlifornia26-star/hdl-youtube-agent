// One entry rotates per day (day-of-year % catalog.length), same pattern as the article engine.
// IMPORTANT: verify each `pageUrl` actually resolves on the live site before your first real run —
// a couple of these are best-guess slugs from memory and may need correcting.
export const CATALOG = [
  {
    slug: "age-one",
    title: "AGE ONE",
    angle: "AI & the information economy",
    pageUrl: "https://highdefinitionlearning.pages.dev/age-one-complete-ai-business-mastery",
    stockKeywords: ["artificial intelligence", "futuristic city", "digital network", "businessman technology"],
  },
  {
    slug: "age-one-premium",
    title: "AGE ONE: Premium Edition",
    angle: "advanced AI business strategy",
    pageUrl: "https://highdefinitionlearning.pages.dev/age-one-standard-edition",
    stockKeywords: ["boardroom", "data analytics", "future technology", "strategy meeting"],
  },
  {
    slug: "bitcoin-standard",
    title: "Bitcoin Standard",
    angle: "Bitcoin & digital finance",
    pageUrl: "https://highdefinitionlearning.pages.dev/bitcoin-standard-pure-mathematics",
    stockKeywords: ["bitcoin", "cryptocurrency", "blockchain", "digital finance"],
  },
  {
    slug: "science-of-feeling-great",
    title: "Science of Feeling Great",
    angle: "wellness & vitality",
    pageUrl: "https://highdefinitionlearning.pages.dev/science-of-feeling-great-5pillar-vitality-blueprint",
    stockKeywords: ["healthy lifestyle", "morning routine", "wellness", "sunrise nature"],
  },
  {
    slug: "art-of-joy",
    title: "Art of Joy",
    angle: "the science of happiness",
    pageUrl: "https://highdefinitionlearning.pages.dev/art-of-joy-landing-page",
    stockKeywords: ["happiness", "joyful people", "sunshine", "smiling"],
  },
  {
    slug: "youtube-algorithms",
    title: "YouTube Algorithms",
    angle: "growing a channel with the algorithm",
    pageUrl: "https://highdefinitionlearning.pages.dev/youtube-algorithms-playbook-original",
    stockKeywords: ["content creator", "video editing", "camera studio", "social media growth"],
  },
  {
    slug: "pet-friendly",
    title: "Pet Friendly",
    angle: "responsible, modern pet care",
    pageUrl: "https://highdefinitionlearning.pages.dev/pet-friendly", // TODO: confirm real slug — not present in this batch
    stockKeywords: ["happy dog", "cat owner", "pet care", "puppy"],
  },
];

export function pickTodaysBook(date = new Date()) {
  const start = new Date(date.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((date - start) / 86400000);
  return CATALOG[dayOfYear % CATALOG.length];
    }
