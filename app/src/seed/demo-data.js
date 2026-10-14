/**
 * The demonstration dataset.
 *
 * This is data, not logic, and it is kept in its own file so that the interesting
 * question - what the demo claims about the market - can be read and argued with
 * in one place without reading any code.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT IN `reference-data.js`
 *
 * `seed.js` states a rule this file deliberately breaks: "Nothing here is invented.
 * There is no fictional trader with a plausible phone number, because a directory
 * that opens with invented listings is a directory nobody can trust."
 *
 * That rule is right, and it is kept, and it is why this dataset lives in a
 * separate database rather than in the seed. A real install must never open with
 * invented traders. A demonstration must, because the engine has nothing to measure
 * otherwise: with one business and two searchers, every finding is suppressed on
 * the privacy floor and every supply count is zero, and neither the gap scoring nor
 * the coverage model can be evaluated at all.
 *
 * So the separation is the safety property, and it is enforced rather than merely
 * intended - see `scripts/seed-demo.js`, which refuses to run against the real
 * install's data directory. The rule is not weakened here; it is honoured by the
 * database, which is the only place it can be.
 *
 * WHAT IS REAL AND WHAT IS NOT
 *
 * Real: every category, every skill, every location, and every relationship between
 * them are read from the platform's own reference data. The businesses below are
 * placed in real districts, categorised against the real taxonomy, and attached to
 * the real skill vocabulary - the vocabulary that ships in `SKILLS`, the one an
 * operator would use to describe them anyway. The searches are real phrases people
 * type, drawn from that vocabulary's own synonyms.
 *
 * Invented: the trading names, the descriptions, and the volumes. Every invented
 * record carries `sourceId: 'seed:demo'`, is registered as provenance under
 * `seed:demo`, and says so in its own description, so any single record inspected on
 * its own is self-describing even if the database was copied out of context.
 *
 * WHAT THE DATASET IS FOR
 *
 * It is built backwards from the six outcomes that need to be demonstrable, rather
 * than forwards from plausible-looking businesses. Each block below exists to make
 * one case visible, and `OUTCOME_EXPECTATIONS` names the case so a test can assert
 * it instead of a human having to eyeball a screenshot.
 *
 *   1. A critical gap where there is genuinely no supply. Unambiguous, and the
 *      product's whole reason to exist.
 *   2. A well-supplied phrase that does NOT become a critical gap. The single most
 *      important thing to show: it is what proves the engine discriminates rather
 *      than declaring everything a crisis.
 *   3. Uneven coverage between districts, because one coverage number cannot
 *      describe both "thirty businesses serve this" and "nothing is known here".
 *   4. A phrase below the k-anonymity floor, so the privacy promise is visible in a
 *      demonstration rather than only in a test.
 *   5. A rising phrase, so the trend annotation has something to annotate.
 *   6. Two- and three-word queries, because the real install has only ever seen
 *      one-word searches: every one of its 34 events had an empty `phrases_json`,
 *      so the entire n-gram path has never run against real data.
 *
 * VOLUMES ARE CHOSEN AGAINST THE FLOOR, NOT FOR IT
 *
 * `kThreshold` is 5 by default, so any phrase with fewer than five distinct actors
 * is suppressed. Most rows below sit comfortably above it, and the ones that sit
 * below it say so in their own comment, because a demonstration that quietly
 * suppressed everything would look identical to a demonstration with no data.
 */

/**
 * Businesses, published through the real review path.
 *
 * THE COUNTS ARE NOT DECORATIVE, AND THIS IS WHY THERE ARE SO MANY
 *
 * They look like filler, and they are the opposite: they are the only thing making
 * the demonstration able to show a *served* market.
 *
 * The scoring curve treats a place as adequately supplied at a supply score of 5.0,
 * and an approved business carries a trust weight of exactly 1, so that score is
 * five matching providers. Demand saturates at ten searches, so a phrase searched
 * more than ten times is already asking for as much as the curve can hear. Put those
 * two together and a phrase with one, two or even four providers in a busy city
 * still scores 1.0 and is still `critical` - which is true, and which the first
 * version of this dataset demonstrated by reporting a city with two phone repair
 * shops as a critical shortage.
 *
 * So Kampala's served trades are given five or six providers each, which is not a
 * stretch: Kampala has a lot of phone repair vendors. Mukono is given two. Entebbe
 * is given none. That produces one finding at each of `none`, `high` and
 * `critical`, which is the only way a demonstration can show that the engine
 * discriminates rather than declaring everything a crisis.
 *
 * Whether those thresholds are *right* is a product question this dataset does not
 * settle - see the note in `demo.js`. What it does is make the current behaviour
 * visible instead of hiding it.
 */
export const DEMO_BUSINESSES = [
  // Kampala District. The well-covered case: five or more providers per served
  // trade, so the engine has to score these as met.
  ['Mobile phone repair', 'Kampala', 'Kampala Mobile Care', 'Mobile phone repair, screen replacement and battery replacement in Central Division.'],
  ['Mobile phone repair', 'Kampala', 'Nakawa Phone Point', 'Mobile phone repair and charging port repair, Nakawa Division.'],
  ['Mobile phone repair', 'Kampala', 'Kampala Phones Limited', 'Mobile phone repair and headphone repair.'],
  ['Mobile phone repair', 'Kampala', 'Rubaga Mobile Repair', 'Mobile phone repair, Kawempe and Central Divisions.'],
  ['Mobile phone repair', 'Kampala', 'Makindye Phone Care', 'Mobile phone repair and screen replacement, Makindye Division.'],
  ['Mobile phone repair', 'Kampala', 'Kampala Mobile Spares', 'Mobile phone repair with spares for common models.'],
  ['Laptop repair', 'Kampala', 'Kampala Laptop Repair', 'Laptop repair, data recovery and software installation.'],
  ['Laptop repair', 'Kampala', 'Nakawa Computer Service', 'Laptop repair and battery replacement.'],
  ['Laptop repair', 'Kampala', 'Kampala Notebooks', 'Laptop repair, data wipe and reset.'],
  ['Laptop repair', 'Kampala', 'Rubaga PC Fix', 'Laptop repair and software installation, Rubaga Division.'],
  ['Laptop repair', 'Kampala', 'Kampala Data Recovery', 'Laptop repair, data recovery and file recovery.'],
  ['Television repair', 'Kampala', 'Rubaga TV Service', 'Television repair and headphone repair, Rubaga Division.'],
  ['Electrician', 'Kampala', 'Kawempe Electrical Works', 'Electrician, wiring and CCTV installation, Kawempe Division.'],
  ['Electrician', 'Kampala', 'Kampala Electricians', 'Electrician and electrical work across the city.'],
  ['Electrician', 'Kampala', 'Nakawa Power', 'Electrician, wiring and solar installation, Nakawa Division.'],
  ['Electrician', 'Kampala', 'Rubaga Wiring Services', 'Electrician and electrical installation, Rubaga Division.'],
  ['Electrician', 'Kampala', 'Kampala Surge Solutions', 'Electrician and electrical work for offices and shops.'],
  ['Plumber', 'Kampala', 'Makindye Plumbing', 'Plumber and solar installation, Makindye Division.'],
  ['Carpenter', 'Kampala', 'Kampala Furniture Makers', 'Carpenter, furniture making and joinery.'],
  ['Tailoring', 'Kampala', 'Kampala Tailors', 'Tailoring, dressmaking and alterations.'],
  ['Shoemaking', 'Kampala', 'Kampala Cobblers', 'Shoemaking and leather repair.'],
  ['Graphic design', 'Kampala', 'Kampala Design Studio', 'Graphic design, branding and printing.'],
  ['Photography', 'Kampala', 'Kampala Photo Studio', 'Photography and videography for events.'],
  ['CCTV installation', 'Kampala', 'Secure Kampala Systems', 'CCTV installation and security camera installation.'],
  ['Networking installation', 'Kampala', 'Kampala Networks', 'Networking installation and LAN setup for offices.'],

  // Wakiso District. Moderate: some trades have two providers, some have none, which
  // is the range a coverage number is for.
  ['Mechanic', 'Wakiso', 'Wakiso Auto Mechanics', 'Mechanic and car mechanic services.'],
  ['Panel beating and painting', 'Nansana', 'Nansana Panel Beaters', 'Panel beating and painting, bodaboda repair.'],
  ['Welder', 'Kira City', 'Kira Metal Works', 'Welder, welding and metal fabrication.'],
  ['Mason', 'Kajjansi', 'Kajjansi Masons', 'Mason and masonry work for buildings.'],
  ['Furniture making', 'Namugongo', 'Namugongo Furniture', 'Furniture making and furniture repair.'],
  ['Motorcycle taxi', 'Kasangati', 'Kasangati Bodaboda', 'Motorcycle taxi and boda service.'],

  // Mukono District. Thin on purpose, and the three welders are the point: with
  // demand saturated, each provider lifts adequacy by a fifth, so three of them
  // move one finding off `critical` and into `high`. That is the only row in the
  // demonstration that is neither an obvious gap nor an obvious non-gap, and a
  // ranked list with one item in the middle is a ranked list somebody can read.
  ['Painter', 'Mukono', 'Mukono Painters', 'Painter and painting and finishing.'],
  ['Welder', 'Mukono', 'Mukono Metal Fabrication', 'Welder and welding for gates and frames.'],
  ['Welder', 'Mukono', 'Mukono Gatesmiths', 'Welder and welding for gates, windows and frames.'],
  ['Welder', 'Mukono', 'Mukono Steelworks', 'Welder, welding and steel fabrication for builders.'],
  ['Data wipe and reset', 'Kyengera', 'Kyengera Device Services', 'Data wipe and reset, factory reset, device refurbishment.'],

  // Entebbe Municipality is deliberately absent. No business, no row, nothing. It is
  // the case where a critical gap is simply true, and it is the only place in the
  // dataset where the answer is not arguable.
]

/**
 * Searches, recorded as real events.
 *
 * `searches` is how many events, `actors` is how many distinct people, and the
 * difference matters: `computeGapScore` keys on distinct actors, so 20 searches from
 * 3 people is still suppressed. Rows below a floor of 5 are marked in their comment.
 *
 * `days` is how far back the demand reaches, counted from today, and `rising` moves
 * the weight into the last three days so the trend comparison has a baseline to
 * disagree with.
 *
 * `results` is what the search would have returned in a world with supply. Zero is
 * the case that matters: it is what makes a phrase an unmet gap rather than a phrase
 * people gave up on.
 */
export const DEMO_DEMAND = [
  // --- Entebbe: no supply at all. The headline opportunity. ---
  {
    query: 'solar installer',
    place: 'Entebbe',
    coverageLevel: 'town',
    searches: 22,
    actors: 14,
    days: 12,
    rising: true,
    results: 0,
    note: 'no business in Entebbe serves this, so the gap is not an estimate',
  },
  {
    query: 'laptop repair',
    place: 'Entebbe',
    coverageLevel: 'town',
    searches: 9,
    actors: 7,
    days: 10,
    results: 0,
    note: 'a second unmet need in the same uncovered place, to show the place not just the phrase repeating',
  },
  {
    query: 'granite worktop',
    place: 'Entebbe',
    coverageLevel: 'town',
    searches: 31,
    actors: 19,
    days: 14,
    rising: true,
    results: 0,
    note: 'the largest single unmet demand in the dataset, and a real trade rather than a service',
  },

  // --- Kampala: well covered. The case that must NOT become a critical gap. ---
  {
    query: 'laptop repair',
    place: 'Kampala',
    coverageLevel: 'city',
    searches: 26,
    actors: 17,
    days: 12,
    results: 3,
    note: 'high demand WITH supply: the engine has to score this as met, or it is just an alarm',
  },
  {
    query: 'mobile phone repair',
    place: 'Kampala',
    coverageLevel: 'city',
    searches: 34,
    actors: 21,
    days: 12,
    results: 4,
    note: 'the most searched phrase in the dataset, and it is served. Demand volume alone must not create an opportunity',
  },
  {
    query: 'electrician',
    place: 'Kampala',
    coverageLevel: 'city',
    searches: 12,
    actors: 9,
    days: 11,
    results: 2,
    note: 'moderate demand with supply, a different severity band from the two above',
  },

  // --- Mukono: thin supply against real demand. The middle of the range. ---
  {
    query: 'welder',
    place: 'Mukono',
    coverageLevel: 'city',
    searches: 15,
    actors: 11,
    days: 12,
    results: 0,
    note: 'demand in a district with almost nothing serving it, but not the stark case Entebbe is',
  },
  {
    query: 'plumber',
    place: 'Mukono',
    coverageLevel: 'city',
    searches: 8,
    actors: 7,
    days: 9,
    results: 0,
    note: 'a second unmet trade in the same district',
  },

  // --- Wakiso: moderate supply, and the rising case. ---
  {
    query: 'motorcycle repair',
    place: 'Kira City',
    coverageLevel: 'city',
    searches: 19,
    actors: 12,
    days: 10,
    rising: true,
    results: 1,
    note: 'rising demand with some supply, so the trend annotation has a gap to annotate rather than a void',
  },
  {
    query: 'furniture repair',
    place: 'Namugongo',
    coverageLevel: 'town',
    searches: 11,
    actors: 8,
    days: 11,
    results: 1,
    note: 'a phrase with exactly one provider, which is the coverage number doing its job',
  },

  // --- Below the floor. The privacy promise, visible rather than asserted. ---
  {
    query: 'sewing machine repair',
    place: 'Kampala',
    coverageLevel: 'city',
    searches: 3,
    actors: 3,
    days: 6,
    results: 0,
    note: 'only 3 distinct actors, so this is suppressed whatever the demand looks like',
  },
  {
    query: 'bicycle repair',
    place: 'Wakiso',
    coverageLevel: 'city',
    searches: 4,
    actors: 2,
    days: 8,
    results: 0,
    note: '4 searches from 2 people: distinct actors, not volume, is what the floor counts',
  },

  // --- District scope rather than city, so a search can be asked at two levels. ---
  {
    query: 'catering services',
    place: 'Kampala District',
    coverageLevel: 'district',
    searches: 17,
    actors: 12,
    days: 12,
    rising: true,
    results: 0,
    note: 'a district-scoped search, which is a different question with a different answer from the city-scoped one',
  },
]

/**
 * Reviews, published through the real moderation path.
 *
 * A directory whose listings are all unrated demonstrates nothing about the
 * ratings feature, so most of these are published and carry an average. Two are
 * left pending and one is rejected: the point of the queue at `/reviews.html` is
 * the work waiting in it, and an empty queue shows the empty state instead.
 *
 * The averages are chosen to differ rather than to all land on five. Kampala Laptop
 * Repair settles on 4.7 from three reviews and Kampala Mobile Care on 4.5 from two,
 * so a directory card, a profile and a histogram all have a number that is not the
 * same number in the next place, which is the only way to see the summarising work.
 *
 * The words are invented, like everything else here, and the addresses are at
 * `example.com` because they are never published and never mailed.
 */
export const DEMO_REVIEWS = [
  {
    business: 'Kampala Laptop Repair',
    rating: 5,
    title: 'Recovered a thesis I had not backed up',
    body: 'The laptop would not boot and the drive was clicking. They recovered every document, including three months of work I had no copy of. They explained what had failed rather than just taking the machine.',
    authorName: 'Miriam Kirabo',
    authorEmail: 'miriam.kirabo@example.com',
    decision: 'publish',
  },
  {
    business: 'Kampala Laptop Repair',
    rating: 5,
    title: 'Honest about a cheap fix',
    body: 'I walked in ready to pay for a new keyboard and they told me it was a software problem. It was done in an hour and the bill was almost nothing.',
    authorName: 'Denis Mugisha',
    authorEmail: 'denis.mugisha@example.com',
    decision: 'publish',
  },
  {
    business: 'Kampala Laptop Repair',
    rating: 4,
    title: 'Battery swapped while I waited',
    body: 'A genuine battery, fitted in under an hour, and they took the old one away. Only the small shop and the waiting bench keep it from five.',
    authorName: 'Aisha Nabirye',
    authorEmail: 'aisha.nabirye@example.com',
    decision: 'publish',
  },
  {
    business: 'Kampala Mobile Care',
    rating: 5,
    title: 'Screen replaced the same morning',
    body: 'I took the phone in at nine and collected it before lunch. They showed me the cracked screen afterwards and the price did not move at the counter.',
    authorName: 'Sarah Nakato',
    authorEmail: 'sarah.nakato@example.com',
    decision: 'publish',
  },
  {
    business: 'Kampala Mobile Care',
    rating: 4,
    title: 'Good repair, longer wait than promised',
    body: 'The work was clean and the phone has been fine since. I waited most of the afternoon rather than the hour I was told, which is the only reason this is not five stars.',
    authorName: 'Peter Ssemakula',
    authorEmail: 'peter.ssemakula@example.com',
    decision: 'publish',
  },
  {
    business: 'Kampala Data Recovery',
    rating: 5,
    title: 'Files back from a drive two others refused',
    body: 'A drive that two other places would not touch came back with everything on it, including photographs from an old phone. Worth the wait.',
    authorName: 'Joel Ssentongo',
    authorEmail: 'joel.ssentongo@example.com',
    decision: 'publish',
  },
  {
    business: 'Nakawa Phone Point',
    rating: 4,
    title: 'Charging port replaced, no upselling',
    body: 'The phone would not charge at all. They replaced the port, tested it in front of me, and did not try to sell me a screen I did not need.',
    authorName: 'Grace Achieng',
    authorEmail: 'grace.achieng@example.com',
    decision: 'publish',
  },
  {
    business: 'Kampala Electricians',
    rating: 3,
    title: 'Neat wiring, slow to come back',
    body: 'The wiring was done well and passed inspection. Getting them back for one small correction took a week of calls, which is the whole of the missing two stars.',
    authorName: 'Hakim Waisale',
    authorEmail: 'hakim.waisale@example.com',
    decision: 'publish',
  },
  {
    business: 'Makindye Plumbing',
    rating: 5,
    title: 'Found the leak two others could not',
    body: 'Two plumbers had already been out and both gave up. This one traced it to a joint behind the wall and fixed it in a morning.',
    authorName: 'Irene Nabukenya',
    authorEmail: 'irene.nabukenya@example.com',
    decision: 'publish',
  },
  {
    business: 'Kampala Furniture Makers',
    rating: 4,
    title: 'Made to the measurements I gave',
    body: 'I brought a drawing and they built exactly what was on it. Solid joinery and delivered on the day they said.',
    authorName: 'Ronald Kaggwa',
    authorEmail: 'ronald.kaggwa@example.com',
    decision: 'publish',
  },
  {
    business: 'Wakiso Auto Mechanics',
    rating: 5,
    title: 'Traced an electrical fault others missed',
    body: 'The car kept stalling and two garages guessed. They found the fault in a loom connector and it has not stalled since.',
    authorName: 'Nasuuna Deborah',
    authorEmail: 'nasuuna.deborah@example.com',
    decision: 'publish',
  },
  {
    business: 'Kyengera Device Services',
    rating: 3,
    title: 'Reset done, everything else cleared too',
    body: 'They reset the phone as asked and it works. I had hoped to keep the messages on it and they were gone as well, so ask carefully what will be kept.',
    authorName: 'Julius Okello',
    authorEmail: 'julius.okello@example.com',
    decision: 'publish',
  },

  // Waiting for a moderator. The queue is the feature, so it opens with work in it.
  {
    business: 'Kampala Photo Studio',
    rating: 5,
    title: 'Wedding coverage that caught everything',
    body: 'They covered the whole day and handed over the edited pictures within a week. The candid shots were the ones we kept.',
    authorName: 'Prossy Namuli',
    authorEmail: 'prossy.namuli@example.com',
  },
  {
    business: 'Kampala Tailors',
    rating: 4,
    title: 'A gomesi that actually fits',
    body: 'Three fittings before it was finished and the fit was right on the day. I will go back.',
    authorName: 'Esther Amollo',
    authorEmail: 'esther.amollo@example.com',
  },

  // Refused, so the reason a review can be turned away is visible rather than only
  // asserted. Kept in the dataset because a queue that only ever approves is a
  // queue nobody has tested.
  {
    business: 'Kampala Cobblers',
    rating: 1,
    title: 'Do not go here',
    body: 'Terrible, the owner is a thief and the whole family is useless. Do not waste your money.',
    authorName: 'Anonymous',
    authorEmail: 'not-a-real-address@example.com',
    decision: 'reject',
    reason: 'A personal attack rather than a description of the work, and it names the owner.',
  },
]

/**
 * Business photographs, as metadata over generated placeholder bytes.
 *
 * There is no honest way to ship a photograph of a business that does not exist,
 * so these are not photographs and do not pretend to be. Each is a deterministic
 * two-tone PNG - the same business always produces the same picture, because there
 * is no `Math.random` here either - which is enough to make the gallery, the
 * thumbnail order and the queue visible. The captions describe what a real
 * photograph of that business would show.
 *
 * The bytes are handed to `buildPhotoUpload`, the same door an upload arrives at,
 * so the demonstration cannot store an image the platform would have refused, and
 * `position` is the order an owner would have arranged them in.
 */
export const DEMO_PHOTOS = [
  // Kampala Mobile Care: two published photos, so the gallery has an order to keep.
  {
    business: 'Kampala Mobile Care',
    position: 0,
    caption: 'Service counter and parts cabinet',
    altText: 'A repair shop counter with a glass display of phone screens and a wall of small parts drawers.',
    decision: 'publish',
  },
  {
    business: 'Kampala Mobile Care',
    position: 1,
    caption: 'A screen replacement in progress',
    altText: 'A technician lifting a cracked phone screen away from the frame with a suction cup.',
    decision: 'publish',
  },
  {
    business: 'Kampala Laptop Repair',
    position: 0,
    altText: 'Rows of open laptops on a workbench, each with a screwdriver tray beside it.',
    caption: 'The workshop bench',
    decision: 'publish',
  },
  {
    business: 'Nakawa Power',
    position: 0,
    caption: 'Wiring a distribution board',
    altText: 'An electrician connecting labelled cables to a wall-mounted distribution board.',
    decision: 'publish',
  },
  {
    business: 'Makindye Plumbing',
    position: 0,
    caption: 'The van and the pipe stock',
    altText: 'A small van with its rear doors open, filled with coils of pipe and plumbing fittings.',
    decision: 'publish',
  },
  {
    business: 'Kampala Furniture Makers',
    position: 0,
    caption: 'Finished tables ready for delivery',
    altText: 'Several finished wooden dining tables standing in a workshop.',
    decision: 'publish',
  },
  {
    business: 'Kampala Photo Studio',
    position: 0,
    caption: 'The studio and its backdrop',
    altText: 'A photography studio with a lit backdrop, softboxes and a tripod.',
    decision: 'publish',
  },
  {
    business: 'Wakiso Auto Mechanics',
    position: 0,
    caption: 'A vehicle on the ramp',
    altText: 'A car raised on a lift inside a garage, with tools laid out on a bench nearby.',
    decision: 'publish',
  },
  {
    business: 'Mukono Metal Fabrication',
    position: 0,
    caption: 'A finished gate ready for delivery',
    altText: 'A welded metal gate leaning against a workshop wall, with a welder working behind it.',
    decision: 'publish',
  },
  {
    business: 'Kyengera Device Services',
    position: 0,
    caption: 'Refurbished handsets on the shelf',
    altText: 'A shelf of refurbished phones, each on a stand with a price card.',
    decision: 'publish',
  },
  {
    business: 'Kampala Design Studio',
    position: 0,
    caption: 'The studio and the print rack',
    altText: 'A design studio desk with monitors, sketches pinned to the wall and a rack of printed posters.',
    decision: 'publish',
  },

  // Waiting for a moderator, so the photo queue is not empty either.
  {
    business: 'Kampala Networks',
    position: 0,
    caption: 'A finished network cabinet',
    altText: 'A wall cabinet of patch panels and switches with neatly bundled cables.',
  },
  {
    business: 'Nansana Panel Beaters',
    position: 0,
    caption: 'A respray in the booth',
    altText: 'A car panel being resprayed inside a paint booth.',
  },

  // Refused, so a rejected photograph and its reason are visible in the owner's
  // view rather than only in a test.
  {
    business: 'Kampala Cobblers',
    position: 0,
    caption: 'Our workshop',
    altText: 'A generic picture of shoes on a shelf.',
    decision: 'reject',
    reason: 'A stock photograph that shows no workshop; it is not this business.',
  },
]

/**
 * What the dataset is supposed to prove, named so a test can assert it.
 *
 * These are claims about outcomes, not about row counts. They are deliberately
 * about behaviour the engine is supposed to get right, because "the seed inserted 22
 * businesses" is not a claim worth failing a test over - it is a fact about a
 * literal, and it is already in the array above.
 */
export const OUTCOME_EXPECTATIONS = {
  /** A place with no supply at all produces an unsuppressed, promotable gap. */
  uncoveredPlaceProducesOpportunity: {
    place: 'Entebbe',
    phrase: 'granite worktop',
    expectSuppressed: false,
    expectOpportunity: true,
  },
  /** High demand where supply exists does not become a critical gap. */
  servedPhraseIsNotAnOpportunity: {
    place: 'Kampala',
    phrase: 'mobile phone repair',
    expectSuppressed: false,
    expectOpportunity: false,
  },
  /** A phrase under the k-anonymity floor is stored and withheld. */
  belowFloorIsSuppressed: {
    place: 'Kampala',
    phrase: 'sewing machine repair',
    expectSuppressed: true,
    expectOpportunity: false,
  },
  /** Entebbe has no businesses and Kampala has many, so coverage is not uniform. */
  coverageIsUneven: {
    thin: 'Entebbe',
    thick: 'Kampala',
  },
  /**
   * A middle severity, which is the expectation that was added last and the one
   * that took the most dataset to satisfy.
   *
   * The first version had zero providers (critical) and five (low) and nothing
   * between, because the score is dominated by how much supply exists and five
   * providers is a cliff rather than a slope. Two providers still scored 0.761, just
   * over the `critical` boundary, and three scored 0.54. So this is asserted at
   * exactly three welders, and if the dataset is edited it will fail here rather
   * than quietly losing the middle of the range.
   */
  middlingSupplyIsNotCritical: {
    place: 'Mukono',
    phrase: 'welder',
    expectSeverity: 'high',
    expectOpportunity: true,
  },
  /** A phrase whose recent days are heavier than its earlier ones, so a trend exists. */
  risingDemandIsPresent: {
    place: 'Kampala District',
    phrase: 'catering services',
    expectTrendUp: true,
  },
}
