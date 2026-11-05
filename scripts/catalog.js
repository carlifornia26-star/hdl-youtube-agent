// One entry rotates per day (day-of-year % catalog.length), same pattern as the article engine.
// IMPORTANT: verify each `pageUrl` actually resolves on the live site before your first real run —
// a couple of these are best-guess slugs from memory and may need correcting.
//
// `titleVariants`: a few alternate phrasings of the same book's title, used so a repeat
// appearance of the same book (which happens every ~CATALOG.length days per channel) doesn't
// upload with the literal same title text as last time. `slug`, `title` (the canonical/first
// variant), `angle`, and `pageUrl` stay fixed — only the displayed video title rotates.
// `categoryId` is the YouTube video category for THIS BOOK's content — not the channel. Since
// pickTodaysBook() rotates every channel through the full catalog (just offset by a day), a
// category tied to the channel instead of the book would be wrong on ~6 of every 7 uploads per
// channel (e.g. a Bitcoin teaser tagged "Entertainment" because it happened to render on the
// channel whose fallback category was set for something else). Tying it to the book instead
// means the tag is correct every time, on every channel, regardless of the day's rotation.
// Reference IDs: Education=27, Science & Technology=28, Howto & Style=26, Pets & Animals=15.
// `complianceTopic` ("finance" | "health" | "vet", omitted otherwise) drives the rotating
// compliance disclaimer line in cf-ai.js's generateScript — set deterministically per book here
// rather than left to the model to decide per-run, so it fires consistently every time this
// book comes up and never fires for books it doesn't apply to.
export const CATALOG = [
  {
    slug: "age-one",
    title: "AGE ONE",
    titleVariants: ["AGE ONE", "AGE ONE: The AI Economy", "AGE ONE — Inside the AI Economy"],
    angle: "AI & the information economy",
    pageUrl: "https://highdefinitionlearning.pages.dev/age-one-complete-ai-business-mastery",
    stockKeywords: ["artificial intelligence", "futuristic city", "digital network", "businessman technology", "computer coding", "robot technology"],
    categoryId: "28", // Science & Technology
  },
  {
    slug: "age-one-premium",
    title: "AGE ONE: Premium Edition",
    titleVariants: ["AGE ONE: Premium Edition", "AGE ONE Premium", "AGE ONE — Advanced Edition"],
    angle: "advanced AI business strategy",
    pageUrl: "https://highdefinitionlearning.pages.dev/age-one-standard-edition",
    stockKeywords: ["boardroom", "data analytics", "future technology", "strategy meeting", "office team", "graph chart"],
    categoryId: "28", // Science & Technology
  },
  {
    slug: "bitcoin-standard",
    title: "Bitcoin Standard",
    titleVariants: ["Bitcoin Standard", "The Bitcoin Standard", "Bitcoin Standard: Digital Money Explained"],
    angle: "Bitcoin & digital finance",
    pageUrl: "https://highdefinitionlearning.pages.dev/bitcoin-standard-pure-mathematics",
    stockKeywords: ["bitcoin", "cryptocurrency", "blockchain", "digital finance", "stock market", "gold coins"],
    categoryId: "27", // Education
    complianceTopic: "finance",
  },
  {
    slug: "science-of-feeling-great",
    title: "Science of Feeling Great",
    titleVariants: ["Science of Feeling Great", "The Science of Feeling Great", "Science of Feeling Great: Everyday Vitality"],
    angle: "wellness & vitality",
    pageUrl: "https://highdefinitionlearning.pages.dev/science-of-feeling-great-5pillar-vitality-blueprint",
    stockKeywords: ["healthy lifestyle", "morning routine", "wellness", "sunrise nature", "yoga meditation", "healthy food"],
    categoryId: "26", // Howto & Style
    complianceTopic: "health",
  },
  {
    slug: "art-of-joy",
    title: "Art of Joy",
    titleVariants: ["Art of Joy", "Art of Joy: Feel Happiness", "The Art of Joy — Everyday Happiness"],
    angle: "the science of happiness",
    pageUrl: "https://highdefinitionlearning.pages.dev/art-of-joy-landing-page",
    stockKeywords: ["happiness", "joyful people", "sunshine", "smiling", "friends laughing", "nature walk"],
    categoryId: "27", // Education
  },
  {
    slug: "youtube-algorithms",
    title: "YouTube Algorithms",
    titleVariants: ["YouTube Algorithms", "YouTube Algorithms: Grow Your Channel", "Cracking the YouTube Algorithm"],
    angle: "growing a channel with the algorithm",
    pageUrl: "https://highdefinitionlearning.pages.dev/youtube-algorithms-playbook-original",
    stockKeywords: ["content creator", "video editing", "camera studio", "social media growth", "smartphone screen", "podcast studio"],
    categoryId: "26", // Howto & Style
  },
  {
    slug: "pet-friendly",
    title: "Pet Friendly",
    titleVariants: ["Pet Friendly", "Pet Friendly: Modern Pet Care", "Pet Friendly — Happier, Healthier Pets"],
    angle: "responsible, modern pet care",
    pageUrl: "https://highdefinitionlearning.pages.dev/pet-friendly", // TODO: confirm real slug — not present in this batch
    stockKeywords: ["happy dog", "cat owner", "pet care", "puppy", "kitten playing", "dog walking park"],
    categoryId: "15", // Pets & Animals
    complianceTopic: "vet",
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

// Per-channel subject split (owner-approved 2026-11-03): each channel now stays inside its own
// niche instead of every channel rotating through the full catalog a day apart. Matches the
// four niches that already exist in niche-playlists.json. Single-book channels (2 and 4)
// revisit the same book daily by design - daily freshness there comes from story mode,
// grounding rotation and title variants, not from switching books.
export const CHANNEL_BOOKS = {
  "1": ["age-one", "age-one-premium", "youtube-algorithms"], // AI & Digital Business
  "2": ["bitcoin-standard"], // Bitcoin & Finance
  "3": ["science-of-feeling-great", "art-of-joy"], // Wellness & Positive Living
  "4": ["pet-friendly"], // Pets
};

// Same rotation mechanics as pickTodaysBook, but scoped to the channel's own book list.
// Falls back to the full catalog for an unknown channel id so a misconfigured run still
// produces a video rather than crashing. titleVariants rotate by lap exactly as before.
// Module-load validation (owner review 2026-11-03): a broken mapping must fail the run loudly,
// never silently pick a book from another channel's niche - the per-channel niche split is the
// approved configuration, so drifting outside it is a hard error, not a fallback.
for (const [ch, slugs] of Object.entries(CHANNEL_BOOKS)) {
  if (!["1", "2", "3", "4"].includes(ch)) throw new Error(`CHANNEL_BOOKS: unknown channel "${ch}"`);
  for (const slug of slugs) {
    if (!CATALOG.some((b) => b.slug === slug)) throw new Error(`CHANNEL_BOOKS channel ${ch}: unknown book slug "${slug}"`);
  }
}
for (const ch of ["1", "2", "3", "4"]) {
  if (!CHANNEL_BOOKS[ch]?.length) throw new Error(`CHANNEL_BOOKS: channel ${ch} has no approved books`);
}

export function pickTodaysBookForChannel(date = new Date(), channelId = "1") {
  const slugs = CHANNEL_BOOKS[String(channelId)];
  if (!slugs) throw new Error(`No approved book mapping for channel ${channelId} - refusing to pick a book outside this channel's approved niche.`);
  if (slugs.some((s) => !CATALOG.some((b) => b.slug === s))) throw new Error(`CHANNEL_BOOKS channel ${channelId} contains an unknown book slug - fix the mapping instead of falling back across niches.`);
  const books = slugs.map((s) => CATALOG.find((b) => b.slug === s));
  const start = new Date(date.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((date - start) / 86400000);
  const index = dayOfYear % books.length;
  const lap = Math.floor(dayOfYear / books.length);
  const book = books[index];
  const variants = book.titleVariants?.length ? book.titleVariants : [book.title];
  const displayTitle = variants[lap % variants.length];
  return { ...book, displayTitle };
}
