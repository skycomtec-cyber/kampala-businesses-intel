/**
 * Reference data for the platform.
 *
 * This file holds places and classifications, not businesses. Nothing here is
 * synthetic content: it is the administrative geography of the Kampala metro and
 * the taxonomy the directory is organised around, written down so a fresh
 * database is useful the moment it is created.
 *
 * Two rules govern what may be added to this file.
 *
 *   1. It must be true of the real world. A wrong ward name in a directory is not
 *      a cosmetic bug, it is a business that cannot be found in its own area.
 *   2. It must be re-importable. Every list carries a version, and the importer
 *      records which version it applied, so a later revision can be diffed against
 *      what is in the database rather than guessed at.
 *
 * Business listings, services, products and demand signals are never seeded. They
 * arrive through the admin api from operators who have spoken to the business.
 */

export const LOCATIONS_VERSION = '2026.01'
export const CATEGORIES_VERSION = '2026.01'
export const SKILLS_VERSION = '2026.01'

const location = (name, kind, extra = {}) => ({ name, kind, ...extra })
const child = (parent, ...children) => ({ ...parent, children })

/**
 * Uganda, down to the settlements the platform is expected to cover first.
 *
 * The shape follows the actual administrative hierarchy: a district contains
 * cities and towns, a city contains divisions, and a town may contain
 * subcounties. Kampala is a district whose principal city is Kampala, which is why
 * a search scoped to "Kampala" and one scoped to "Kampala District" are different
 * queries with different answers.
 */
export const LOCATIONS = [
  child(
    location('Uganda', 'country', { latitude: 1.3733, longitude: 32.5825 }),
    child(
      location('Central Region', 'region'),
      child(
        location('Kampala District', 'district', { externalCode: 'UG-112' }),
        child(
          location('Kampala', 'city', { latitude: 0.3476, longitude: 32.5825 }),
          location('Central Division', 'division'),
          location('Kawempe Division', 'division'),
          location('Makindye Division', 'division'),
          location('Nakawa Division', 'division'),
          location('Rubaga Division', 'division'),
        ),
      ),
      {
        ...location('Wakiso District', 'district', {
          externalCode: 'UG-041',
          latitude: 0.3713,
          longitude: 32.5714,
        }),
        children: [
          location('Wakiso', 'city', { latitude: 0.3713, longitude: 32.5714 }),
          location('Kira City', 'city', { latitude: 0.3167, longitude: 32.6333 }),
          location('Nansana', 'town', { latitude: 0.3667, longitude: 32.5167 }),
          location('Kajjansi', 'town', { latitude: 0.2167, longitude: 32.5333 }),
          location('Namugongo', 'town', { latitude: 0.35, longitude: 32.6 }),
          location('Kasangati', 'town'),
        ],
      },
      {
        ...location('Mukono District', 'district', {
          externalCode: 'UG-235',
          latitude: 0.3575,
          longitude: 32.7583,
        }),
        children: [
          location('Mukono', 'city', { latitude: 0.3575, longitude: 32.7583 }),
          location('Kyengera', 'town'),
        ],
      },
      child(
        location('Entebbe Municipality', 'district', { externalCode: 'UG-043' }),
        location('Entebbe', 'town', { latitude: 0.0512, longitude: 32.4633 }),
      ),
    ),
    child(
      location('Eastern Region', 'region'),
      child(
        location('Mbale District', 'district', { externalCode: 'UG-218' }),
        child(location('Mbale', 'city', { latitude: 1.0827, longitude: 34.1667 })),
      ),
      child(
        location('Jinja District', 'district', { externalCode: 'UG-202' }),
        child(location('Jinja', 'city', { latitude: 0.4478, longitude: 33.2026 })),
      ),
    ),
    child(
      location('Northern Region', 'region'),
      child(
        location('Gulu District', 'district', { externalCode: 'UG-301' }),
        child(location('Gulu', 'city', { latitude: 2.7746, longitude: 32.299 })),
      ),
    ),
    child(
      location('Western Region', 'region'),
      child(
        location('Mbarara District', 'district', { externalCode: 'UG-406' }),
        child(location('Mbarara', 'city', { latitude: -0.6072, longitude: 30.6545 })),
      ),
    ),
  ),
]

/**
 * The category tree, as paths.
 *
 * Roots come from `core/taxonomy.js` so the top-level navigation is declared in
 * the same diff as the rules that depend on it. Everything below them is ordered
 * the way somebody looking for the thing would look: repairs before retailers,
 * workshops before warehouses.
 */
export const CATEGORIES = [
  {
    path: 'goods-and-products',
    children: [
      { path: 'goods-and-products/electronics-and-appliances' },
      { path: 'goods-and-products/mobile-phones-and-accessories' },
      { path: 'goods-and-products/computers-and-accessories' },
      { path: 'goods-and-products/building-materials' },
      { path: 'goods-and-products/tools-and-hardware' },
      { path: 'goods-and-products/furniture-and-fittings' },
      { path: 'goods-and-products/fashion-and-textiles' },
      { path: 'goods-and-products/household-goods' },
      { path: 'goods-and-products/food-and-groceries' },
      { path: 'goods-and-products/auto-parts-and-accessories' },
      { path: 'goods-and-products/medical-supplies' },
      { path: 'goods-and-products/agricultural-inputs' },
      { path: 'goods-and-products/books-and-stationery' },
    ],
  },
  {
    path: 'services',
    children: [
      {
        path: 'services/repair-and-maintenance',
        children: [
          { path: 'services/repair-and-maintenance/phone-repair' },
          { path: 'services/repair-and-maintenance/computer-repair' },
          { path: 'services/repair-and-maintenance/electrical-repair' },
          { path: 'services/repair-and-maintenance/appliance-repair' },
          { path: 'services/repair-and-maintenance/vehicle-repair' },
        ],
      },
      {
        path: 'services/trades-and-construction',
        children: [
          { path: 'services/trades-and-construction/carpentry' },
          { path: 'services/trades-and-construction/masonry' },
          { path: 'services/trades-and-construction/plumbing' },
          { path: 'services/trades-and-construction/electrical-installation' },
          { path: 'services/trades-and-construction/painting-and-finishing' },
          { path: 'services/trades-and-construction/welding-and-metalwork' },
          { path: 'services/trades-and-construction/roofing' },
          { path: 'services/trades-and-construction/building-contractors' },
          { path: 'services/trades-and-construction/landscaping-and-groundworks' },
        ],
      },
      {
        path: 'services/professional-services',
        children: [
          { path: 'services/professional-services/accounting-and-bookkeeping' },
          { path: 'services/professional-services/legal-services' },
          { path: 'services/professional-services/consultancy' },
          { path: 'services/professional-services/translation-and-interpreting' },
        ],
      },
      {
        path: 'services/health-and-medical',
        children: [
          { path: 'services/health-and-medical/clinics-and-hospitals' },
          { path: 'services/health-and-medical/medical-laboratories' },
          { path: 'services/health-and-medical/pharmacy' },
          { path: 'services/health-and-medical/physiotherapy' },
        ],
      },
      {
        path: 'services/education-and-training',
        children: [
          { path: 'services/education-and-training/schools-and-colleges' },
          { path: 'services/education-and-training/vocational-training' },
          { path: 'services/education-and-training/private-tutoring' },
        ],
      },
      {
        path: 'services/it-and-digital',
        children: [
          { path: 'services/it-and-digital/networking-and-internet' },
          { path: 'services/it-and-digital/information-technology-services' },
          { path: 'services/it-and-digital/web-and-software' },
          { path: 'services/it-and-digital/mobile-money-and-payments' },
          { path: 'services/it-and-digital/cybersecurity' },
        ],
      },
      {
        path: 'services/transport-and-logistics',
        children: [
          { path: 'services/transport-and-logistics/car-hire-and-taxis' },
          { path: 'services/transport-and-logistics/trucking-and-haulage' },
          { path: 'services/transport-and-logistics/moving-and-storage' },
          { path: 'services/transport-and-logistics/motorcycle-and-bodaboda' },
        ],
      },
      {
        path: 'services/hospitality-and-food',
        children: [
          { path: 'services/hospitality-and-food/restaurants' },
          { path: 'services/hospitality-and-food/catering' },
          { path: 'services/hospitality-and-food/hotels-and-lodging' },
          { path: 'services/hospitality-and-food/bars-and-nightlife' },
          { path: 'services/hospitality-and-food/food-services' },
        ],
      },
      {
        path: 'services/beauty-and-personal-care',
        children: [
          { path: 'services/beauty-and-personal-care/hairdressing' },
          { path: 'services/beauty-and-personal-care/barbering' },
          { path: 'services/beauty-and-personal-care/nail-and-spa' },
        ],
      },
      { path: 'services/cleaning-and-sanitation' },
      { path: 'services/security-services' },
      { path: 'services/event-services' },
      { path: 'services/real-estate' },
      { path: 'services/real-estate/property-sales-and-leasing' },
      { path: 'services/agricultural-services' },
    ],
  },
  {
    path: 'skills-and-talent',
    children: [
      { path: 'skills-and-talent/artisans-and-craftspeople' },
      { path: 'skills-and-talent/technicians-and-engineers' },
      { path: 'skills-and-talent/creative-and-media' },
      { path: 'skills-and-talent/domestic-and-care-work' },
      { path: 'skills-and-talent/driving-and-transport' },
      { path: 'skills-and-talent/language-and-communication' },
      { path: 'skills-and-talent/training-and-tutoring' },
    ],
  },
  {
    path: 'second-life-electronics',
    children: [
      { path: 'second-life-electronics/device-repair' },
      { path: 'second-life-electronics/device-refurbishment' },
      { path: 'second-life-electronics/parts-recovery' },
      { path: 'second-life-electronics/resale-and-trading' },
      { path: 'second-life-electronics/recycling-and-e-waste' },
      { path: 'second-life-electronics/data-and-storage-services' },
    ],
  },
  {
    path: 'places-and-premises',
    children: [
      { path: 'places-and-premises/workshops' },
      { path: 'places-and-premises/retail-space' },
      { path: 'places-and-premises/offices' },
      { path: 'places-and-premises/markets-and-stalls' },
      { path: 'places-and-premises/warehouses-and-storage' },
      { path: 'places-and-premises/studios-and-creative-spaces' },
    ],
  },
]

/** Second Life Electronics is a vertical, and this is what marks it as one. */
const SECOND_LIFE_PREFIX = 'second-life-electronics'

/**
 * The skill vocabulary, and the category each skill belongs to.
 *
 * Skills are open: an operator can add one that is not on this list and it will
 * still be counted. What this list buys is that a person searching "TV fixer" and
 * a business listing itself under "Television repair" end up on the same
 * measurement, which is the only way a supply count for a skill means anything.
 *
 * Synonyms exist for the same reason: they are what lets a demand phrase be mapped
 * onto a skill without an exact string match.
 */
export const SKILLS = [
  { name: 'Mobile phone repair', category: 'second-life-electronics/device-repair', synonyms: ['phone repair', 'phone fixer', 'screen replacement'] },
  { name: 'Laptop repair', category: 'second-life-electronics/device-repair', synonyms: ['computer repair', 'notebook repair', 'pc repair'] },
  { name: 'Television repair', category: 'second-life-electronics/device-repair', synonyms: ['tv repair', 'tv fixer'] },
  { name: 'Headphone repair', category: 'second-life-electronics/device-repair', synonyms: ['earphone repair'] },
  { name: 'Battery replacement', category: 'second-life-electronics/device-repair', synonyms: ['battery change'] },
  { name: 'Board level repair', category: 'second-life-electronics/device-repair', synonyms: ['micro soldering', 'chip-level repair'] },
  { name: 'Screen replacement', category: 'second-life-electronics/device-repair' },
  { name: 'Charging port repair', category: 'second-life-electronics/device-repair' },
  { name: 'Software installation', category: 'second-life-electronics/device-refurbishment' },
  { name: 'Data wipe and reset', category: 'second-life-electronics/data-and-storage-services', synonyms: ['factory reset', 'data sanitisation'] },
  { name: 'Data recovery', category: 'second-life-electronics/data-and-storage-services', synonyms: ['file recovery'] },
  { name: 'Device refurbishment', category: 'second-life-electronics/device-refurbishment', synonyms: ['refurbishing', 'reconditioning'] },
  { name: 'Cosmetics and finishing', category: 'second-life-electronics/device-refurbishment' },
  { name: 'Parts harvesting', category: 'second-life-electronics/parts-recovery', synonyms: ['parts sourcing', 'spare parts'] },
  { name: 'E-waste recycling', category: 'second-life-electronics/recycling-and-e-waste', synonyms: ['electronic waste', 'scrap electronics'] },
  { name: 'Used electronics trading', category: 'second-life-electronics/resale-and-trading', synonyms: ['second hand electronics', 'used gadgets'] },
  { name: 'Mobile money services', category: 'services/it-and-digital/mobile-money-and-payments', synonyms: ['mobile money', 'momo'] },
  { name: 'Networking installation', category: 'services/it-and-digital/networking-and-internet', synonyms: ['network installation', 'lan setup'] },
  { name: 'CCTV installation', category: 'services/trades-and-construction/electrical-installation', synonyms: ['security camera installation', 'cctv'] },
  { name: 'Electrician', category: 'services/trades-and-construction/electrical-installation', synonyms: ['wiring', 'electrical work'] },
  { name: 'Solar installation', category: 'services/trades-and-construction/electrical-installation', synonyms: ['solar', 'solar system'] },
  { name: 'Plumber', category: 'services/trades-and-construction/plumbing' },
  { name: 'Carpenter', category: 'services/trades-and-construction/carpentry', synonyms: ['joinery', 'woodwork'] },
  { name: 'Mason', category: 'services/trades-and-construction/masonry', synonyms: ['bricklayer', 'construction'] },
  { name: 'Painter', category: 'services/trades-and-construction/painting-and-finishing' },
  { name: 'Welder', category: 'services/trades-and-construction/welding-and-metalwork', synonyms: ['welding', 'fabrication'] },
  { name: 'Roofer', category: 'services/trades-and-construction/roofing' },
  { name: 'Typing and printing', category: 'skills-and-talent/creative-and-media', synonyms: ['photocopying', 'printing'] },
  { name: 'Graphic design', category: 'skills-and-talent/creative-and-media', synonyms: ['design', 'branding'] },
  { name: 'Photography', category: 'skills-and-talent/creative-and-media' },
  { name: 'Videography', category: 'skills-and-talent/creative-and-media', synonyms: ['video shooting', 'videography'] },
  { name: 'Tailoring', category: 'skills-and-talent/artisans-and-craftspeople', synonyms: ['dressmaking', 'sewing'] },
  { name: 'Shoemaking', category: 'skills-and-talent/artisans-and-craftspeople' },
  { name: 'Furniture making', category: 'skills-and-talent/artisans-and-craftspeople', synonyms: ['furniture repair', 'upholstery'] },
  { name: 'Handicraft', category: 'skills-and-talent/artisans-and-craftspeople', synonyms: ['crafts'] },
  { name: 'Masonry work', category: 'skills-and-talent/artisans-and-craftspeople' },
  { name: 'Mechanic', category: 'services/repair-and-maintenance/vehicle-repair', synonyms: ['car mechanic', 'auto repair'] },
  { name: 'Panel beating and painting', category: 'services/repair-and-maintenance/vehicle-repair', synonyms: ['bodaboda repair', 'motorcycle repair'] },
  { name: 'Driving', category: 'skills-and-talent/driving-and-transport', synonyms: ['driving licence', 'driver'] },
  { name: 'Motorcycle taxi', category: 'skills-and-talent/driving-and-transport', synonyms: ['bodaboda', 'boda'] },
  { name: 'Housekeeping', category: 'skills-and-talent/domestic-and-care-work', synonyms: ['cleaning', 'maid services'] },
  { name: 'Care work', category: 'skills-and-talent/domestic-and-care-work', synonyms: ['nursing', 'caregiving'] },
  { name: 'Hairdressing', category: 'services/beauty-and-personal-care/hairdressing' },
  { name: 'Barbering', category: 'services/beauty-and-personal-care/barbering', synonyms: ['salon'] },
  { name: 'Nail technician', category: 'services/beauty-and-personal-care/nail-and-spa' },
  { name: 'Catering', category: 'services/hospitality-and-food/catering', synonyms: ['event catering'] },
  { name: 'Cook', category: 'services/hospitality-and-food/restaurants' },
  { name: 'Restaurant', category: 'services/hospitality-and-food/restaurants' },
  { name: 'Bookkeeping', category: 'services/professional-services/accounting-and-bookkeeping', synonyms: ['accounting'] },
  { name: 'Tax filing', category: 'services/professional-services/accounting-and-bookkeeping' },
  { name: 'Mobile app development', category: 'services/it-and-digital/web-and-software', synonyms: ['app development', 'software development'] },
  { name: 'Web development', category: 'services/it-and-digital/web-and-software', synonyms: ['web design', 'websites'] },
  { name: 'IT support', category: 'services/it-and-digital', synonyms: ['computer support', 'tech support'] },
  { name: 'Private tutoring', category: 'services/education-and-training/private-tutoring', synonyms: ['tuition', 'tutoring'] },
  { name: 'Vocational training', category: 'services/education-and-training/vocational-training' },
  { name: 'Security guarding', category: 'services/security-services' },
  { name: 'Cleaning services', category: 'services/cleaning-and-sanitation', synonyms: ['sanitation', 'fumigation', 'pest control'] },
  { name: 'Moving and packing', category: 'services/transport-and-logistics/moving-and-storage' },
  { name: 'Truck driving', category: 'services/transport-and-logistics/trucking-and-haulage' },
  { name: 'Lodging', category: 'services/hospitality-and-food/hotels-and-lodging', synonyms: ['hotel', 'guest house'] },
  { name: 'Legal services', category: 'services/professional-services/legal-services', synonyms: ['lawyer', 'advocate'] },
  { name: 'Physiotherapy', category: 'services/health-and-medical/physiotherapy' },
  { name: 'Laboratory services', category: 'services/health-and-medical/medical-laboratories' },
  { name: 'Pharmacy', category: 'services/health-and-medical/pharmacy', synonyms: ['chemist', 'drug shop'] },
  { name: 'Clinic', category: 'services/health-and-medical/clinics-and-hospitals', synonyms: ['hospital', 'health centre'] },
]

/** Vertical for a category path, or null when the path is not in a vertical. */
export function verticalForCategoryPath(categoryPath) {
  return categoryPath.startsWith(`${SECOND_LIFE_PREFIX}/`) ? SECOND_LIFE_PREFIX : null
}




