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
