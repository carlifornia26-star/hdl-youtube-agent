// One entry rotates per day (day-of-year % catalog.length), same pattern as the article engine.
// IMPORTANT: verify each `pageUrl` actually resolves on the live site before your first real run —
// a couple of these are best-guess slugs from memory and may need correcting.
//
// `titleVariants`: a few alternate phrasings of the same book's title, used so a repeat
// appearance of the same book (which happens every ~CATALOG.length days per channel) doesn't
// upload with the literal same title text as last time. `slug`, `title` (the canonical/first
// variant), `angle`, and `pageUrl` stay fixed — only the displayed video title rotates.
export const CATALOG = [
  {
    slug: "age-one",
    title: "AGE ONE",
    titleVariants: ["AGE ONE", "AGE ONE: The AI Economy", "AGE ONE — Inside the AI Economy"],
    angle: "AI & the information economy",
    pageUrl: "https://highdefinitionlearning.pages.dev/age-one-complete-ai-business-mastery",
    stockKeywords: ["artificial intelligence", "futuristic city", "digital network", "businessman technology", "computer coding", "robot technology"],
  },
  {
    slug: "age-one-premium",
    title: "AGE ONE: Premium Edition",
    titleVariants: ["AGE ONE: Premium Edition", "AGE ONE Premium", "AGE ONE — Advanced Edition"],
    angle: "advanced AI business strategy",
    pageUrl: "https://highdefinitionlearning.pages.dev/age-one-standard-edition",
    stockKeywords: ["boardroom", "data analytics", "future technology", "strategy meeting", "office team", "graph chart"],
  },
  {
    slug: "bitcoin-standard",
    title: "Bitcoin Standard",
    titleVariants: ["Bitcoin Standard", "The Bitcoin Standard", "Bitcoin Standard: Digital Money Explained"],
    angle: "Bitcoin & digital finance",
    pageUrl: "https://highdefinitionlearning.pages.dev/bitcoin-standard-pure-mathematics",
    stockKeywords: ["bitcoin", "cryptocurrency", "blockchain", "digital finance", "stock market", "gold coins"],
  },
  {
    slug: "science-of-feeling-great",
    title: "Science of Feeling Great",
    titleVariants: ["Science of Feeling Great", "The Science of Feeling Great", "Science of Feeling Great: Everyday Vitality"],
    angle: "wellness & vitality",
    pageUrl: "https://highdefinitionlearning.pages.dev/science-of-feeling-great-5pillar-vitality-blueprint",
    stockKeywords: ["healthy lifestyle", "morning routine", "wellness", "sunrise nature", "yoga meditation", "healthy food"],
  },
  {
    slug: "art-of-joy",
    title: "Art of Joy",
    titleVariants: ["Art of Joy", "Art of Joy: Feel Happiness", "The Art of Joy — Everyday Happiness"],
    angle: "the science of happiness",
    pageUrl: "https://highdefinitionlearning.pages.dev/art-of-joy-landing-page",
    stockKeywords: ["happiness", "joyful people", "sunshine", "smiling", "friends laughing", "nature walk"],
  },
  {
    slug: "youtube-algorithms",
    title: "YouTube Algorithms",
    titleVariants: ["YouTube Algorithms", "YouTube Algorithms: Grow Your Channel", "Cracking the YouTube Algorithm"],
    angle: "growing a channel with the algorithm",
    pageUrl: "https://highdefinitionlearning.pages.dev/youtube-algorithms-playbook-original",
    stockKeywords: ["content creator", "video editing", "camera studio", "social media growth", "smartphone screen", "podcast studio"],
  },
  {
    slug: "pet-friendly",
    title: "Pet Friendly",
    titleVariants: ["Pet Friendly", "Pet Friendly: Modern Pet Care", "Pet Friendly — Happier, Healthier Pets"],
    angle: "responsible, modern pet care",
    pageUrl: "https://highdefinitionlearning.pages.dev/pet-friendly", // TODO: confirm real slug — not present in this batch
    stockKeywords: ["happy dog", "cat owner", "pet care", "puppy", "kitten playing", "dog walking park"],
  },
];

// `channelOffset` shifts which slot of the daily rotation a given channel reads from, so
// multiple channels calling this on the SAME calendar day land on different books instead of
// all picking the identical one. Pass (channelId - 1) as the offset — e.g. channel 1 -> 0,
// channel 2 -> 1, channel 3 -> 2. This guarantees distinct books across up to CATALOG.length
// simultaneous channels (currently 3 channels vs. 7 books, so no collision is possible).
//
// `lap` = how many full trips through the catalog this slot has made — used to pick which
// titleVariants entry to use, so the Nth time a given channel revisits the same book, it gets
// a different (but still cycling, so eventually repeating) title phrasing rather than the exact
// same title text as its last appearance.
export function pickTodaysBook(date = new Date(), channelOffset = 0) {
  const start = new Date(date.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((date - start) / 86400000);
  const slot = dayOfYear + channelOffset;
  const index = slot % CATALOG.length;
  const lap = Math.floor(slot / CATALOG.length);
  const book = CATALOG[index];
  const variants = book.titleVariants?.length ? book.titleVariants : [book.title];
  const displayTitle = variants[lap % variants.length];
  return { ...book, displayTitle };
                    }
