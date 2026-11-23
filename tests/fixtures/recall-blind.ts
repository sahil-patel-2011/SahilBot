export interface SavedFact { text: string; category: string }
export interface PastChat { title: string; daysAgo: number; user: string[] }
export interface RecallCase { ask: string; need: string[]; earlier?: string[] }
export interface NegativeCase { ask: string; mustNot: string[] }

export const BLIND_KEY: SavedFact[] = [
  { category: 'profile', text: 'My name is Bronwen Achterberg, everyone calls me Bron, and I turned 41 in March' },
  { category: 'location', text: 'I live at 214 Tamarack Lane, Duluth, MN 55812' },
  { category: 'person', text: 'My husband is Teodor Achterberg, his cell is 218-555-0147' },
  { category: 'person', text: 'My daughter Wilhelmina (Mina) is 9 and goes to Lakeview Elementary, in Mr. Haskell\'s class' },
  { category: 'person', text: 'My son Anselm is 5 and attends Little Pines Preschool' },
  { category: 'person', text: 'The kids\' pediatrician is Dr. Ines Marchetti at Superior Kids Clinic, phone 218-555-0192' },
  { category: 'person', text: 'Our babysitter is Colette Vandermeer, her number is 218-555-0126, she charges $22 an hour' },
  { category: 'person', text: 'My mother Odalys lives in Tucson, Arizona, her phone is 520-555-0173' },
  { category: 'person', text: 'My brother Casimir lives in Halifax, his email is casimir.a@fastmail.example' },
  { category: 'profile', text: 'I am allergic to shellfish and tree nuts and carry an EpiPen' },
  { category: 'preference', text: 'Teodor is vegetarian, and Mina doesn\'t eat mushrooms' },
  { category: 'person', text: 'My dentist is Dr. Okafor at Lakewalk Dental, appointments by calling 218-555-0110' },
  { category: 'work', text: 'I run Kiln & Ledger, a ceramics studio with a freelance bookkeeping side business' },
  { category: 'work', text: 'My biggest bookkeeping client is Harborline Marine, the contact is Gudrun Solheim, gudrun@harborline.example' },
  { category: 'work', text: 'My second client is Northshore Orthodontics; invoices go to billing@northshoreortho.example on net 30 terms' },
  { category: 'work', text: 'My bookkeeping rate is $65 an hour and ceramics commissions start at $140' },
  { category: 'fact', text: 'We bank at Range Credit Union and the mortgage payment of $1,840 is due on the 3rd of each month' },
  { category: 'fact', text: 'I drive a 2019 Subaru Outback, plate JNK 4471, and get oil changes at Gopher Auto' },
  { category: 'fact', text: 'Our greyhound Biscuit is 7, his vet is Dr. Palmquist at North Shore Vet, 218-555-0158' },
  { category: 'fact', text: 'Our cat Ferdinand needs his thyroid pill every morning at 7' },
  { category: 'rule', text: 'I swim laps at the Heritage Center every Tuesday and Thursday at 6am' },
  { category: 'rule', text: 'Kiln firings happen on Sunday evenings, bisque to cone 04' },
  { category: 'date', text: 'Our wedding anniversary is September 12' },
  { category: 'date', text: 'Mina\'s birthday is July 30 and Anselm\'s birthday is February 9' },
  { category: 'date', text: 'Teodor\'s birthday is November 2' },
  { category: 'preference', text: 'I like drafts in a warm, plain tone with no exclamation marks, and I sign emails Bron' },
  { category: 'preference', text: 'My coffee order is an oat-milk cortado, no sugar' },
  { category: 'location', text: 'My studio is at 88 Canal Park Drive, Unit 3, and the door code is 7391' },
  { category: 'trip', text: 'We are planning a trip to Vancouver Island in June 2027 with Teodor\'s sister Linnea' },
  { category: 'fact', text: 'Our health insurance is BlueNorth, member ID BNX-908-2217' },
];

function pick<T>(list: T[], i: number, stride: number, shift: number): T {
  return list[(i * stride + shift) % list.length];
}

const books = ['The Overstory', 'Piranesi', 'Braiding Sweetgrass', 'The Remains of the Day', 'Station Eleven', 'A Gentleman in Moscow', 'Educated', 'Circe', 'The Dispossessed', 'Pachinko', 'Klara and the Sun', 'The Secret History', 'Project Hail Mary', 'Lessons in Chemistry', 'Demon Copperhead', 'Tomorrow, and Tomorrow, and Tomorrow', 'The Book Thief', 'Gilead', 'Wolf Hall', 'Cloud Cuckoo Land'];
const bookOpinions = ['and found it slow but worth it', 'and honestly loved the ending', 'and thought the middle dragged', 'and want to reread it next winter', 'and would not recommend it to my book club', 'and thought the prose was gorgeous', 'and gave it four stars', 'and could not put it down'];
const shows = ['Slow Horses', 'The Bear', 'Severance', 'Andor', 'Ted Lasso', 'Only Murders in the Building', 'Shogun', 'Abbott Elementary', 'The Great British Bake Off', 'Bluey', 'Hacks', 'Reservation Dogs', 'Fargo', 'Succession', 'Hijack', 'Somebody Somewhere'];
const showTakes = ['and we watch an episode most Fridays', 'but I fell asleep during the finale', 'and Teodor refuses to admit he likes it', 'and I think the second season was the best', 'and I am rationing the last few episodes', 'and it is my comfort rewatch', 'and I still cannot decide how I feel about it'];
const items = ['a cast iron skillet', 'a set of wool dryer balls', 'a pair of trail running shoes', 'a standing desk mat', 'a pottery wheel splash pan', 'a mechanical keyboard', 'a French press', 'a hand-cranked pasta maker', 'a box of linoleum block printing tools', 'a bike pump', 'a pair of leather work gloves', 'a ceramic water filter', 'a canvas apron', 'a thermal lunch bag', 'a pack of sketchbooks', 'a bird feeder', 'a magnetic knife strip', 'a pair of noise-cancelling headphones', 'a stainless thermos', 'a rain jacket', 'a set of watercolor pans', 'a seed starting tray', 'a kitchen scale', 'a cordless drill', 'a hammock'];
const stores = ['online', 'at the farmers market', 'at a garage sale', 'from a friend\'s shop', 'on sale at the outlet mall', 'at the hardware store', 'from a small maker on Etsy', 'at an estate sale', 'at the co-op', 'during a Black Friday sale'];
const foods = ['wild rice soup', 'pickled red onions', 'cardamom buns', 'dark rye bread', 'roasted cauliflower', 'lemon bars', 'miso butter noodles', 'blueberry pancakes', 'black bean chili', 'sourdough pizza', 'smoked whitefish dip', 'cinnamon oatmeal', 'sweet potato curry', 'tabbouleh', 'apple crisp', 'grilled halloumi'];
const foodTakes = ['is my favorite weeknight comfort food', 'is overrated and I will die on that hill', 'tastes best the day after you make it', 'is something I keep meaning to learn to make properly', 'is the one dish the kids will always eat', 'is better with extra lemon', 'needs more salt than any recipe says'];
const hobbies = ['go for a slow walk along the lake', 'sketch in a pocket notebook', 'do the Saturday crossword', 'knit a few rows while the kids do homework', 'listen to a podcast while glazing', 'bake bread on Saturday mornings', 'forage for chokecherries in late summer', 'practice hand-lettering', 'play the ukulele badly', 'bike the lakewalk trail', 'repot houseplants', 'sort my glaze test tiles', 'visit thrift stores for old pottery', 'cross-country ski when there is snow', 'do a jigsaw puzzle on rainy days', 'write postcards to old friends'];
const freqs = ['most evenings', 'about twice a week', 'every few weekends', 'whenever I have a free hour', 'on slow Sunday afternoons', 'a couple of times a month', 'before the kids wake up', 'more than I admit'];
const habits = ['I keep a running list of studio tasks on a paper notepad', 'I drink my first glass of water before any coffee', 'I leave my phone in the kitchen overnight', 'I always read the last page of a book first', 'I label every shelf in the studio with masking tape', 'I round my timers up to the next five minutes', 'I check the weather forecast twice before any plan', 'I buy stamps in bulk and always have some on hand', 'I prefer paper receipts for anything over fifty dollars', 'I turn the thermostat down to 66 at night', 'I like to arrive ten minutes early to everything', 'I keep a spare pair of reading glasses in the car', 'I wash studio towels separately from everything else', 'I do the dishes right after dinner, never in the morning', 'I save voice memos instead of typing notes while driving', 'I rotate the same five dinners during busy weeks', 'I prefer window seats and always book them early', 'I write the date on the bottom of every pot I finish', 'I snooze my alarm exactly once', 'I keep a jar of dried lavender near the front door'];
const tools = ['a dark mode setting on every app', 'the paper planner over a calendar app', 'a spreadsheet for tracking studio sales', 'a handwritten shopping list', 'a shared grocery list the whole family edits', 'a basic flip timer for kiln checks', 'a label maker for pantry jars', 'a notes app for glaze recipes', 'a simple budgeting app with no bank syncing', 'an e-reader with a warm light', 'a film camera for family trips', 'a small whiteboard on the fridge'];
const toolTakes = ['and I will not switch', 'because it just works for me', 'even though everyone says it is outdated', 'and I recommend it to anyone who asks', 'though I keep meaning to try something new', 'and the kids have started to copy me'];
const opinions = ['I think open-plan offices are a mistake', 'I find cold brew too bitter unless it is diluted', 'I would rather have a small garden done well than a big one done badly', 'I believe handmade mugs should feel slightly heavy', 'I think most podcasts are twenty minutes too long', 'I prefer wool socks to cotton in every season', 'I like rain more than snow, despite living where it snows', 'I think matte glazes age better than glossy ones', 'I do not trust recipes that say serves four but fit a toddler', 'I think the best bookstores are the cluttered ones', 'I find group chats exhausting after nine pm', 'I think a good pair of scissors is worth paying for', 'I like folk music more than I ever expected to', 'I consider a clean desk a sign of procrastination', 'I think every kitchen needs a bowl for lemons', 'I believe thank-you notes still matter', 'I find audiobooks work only for fiction', 'I think the fall colors peak a week earlier every year', 'I prefer a manual car for winter driving but gave up on that', 'I think blue and white dishes go with everything'];

function build(): SavedFact[] {
  const out: SavedFact[] = [];
  const seen = new Set<string>();
  const add = (text: string, category: string) => {
    if (!seen.has(text)) { seen.add(text); out.push({ text, category }); }
  };
  let i = 0;
  while (i < 5000 && out.length < 40) { add(`I read ${pick(books, i, 1, 0)} ${pick(bookOpinions, i, 3, Math.floor(i / books.length))}`, 'preference'); i++; }
  i = 0;
  while (i < 5000 && out.length < 80) { add(`I have been watching ${pick(shows, i, 1, 0)} ${pick(showTakes, i, 3, Math.floor(i / shows.length))}`, 'preference'); i++; }
  i = 0;
  while (i < 5000 && out.length < 130) { add(`I bought ${pick(items, i, 1, 0)} ${pick(stores, i, 3, Math.floor(i / items.length))} for $${12 + ((i * 17) % 90)}`, 'fact'); i++; }
  i = 0;
  while (i < 5000 && out.length < 170) { add(`I think ${pick(foods, i, 1, 0)} ${pick(foodTakes, i, 3, Math.floor(i / foods.length))}`, 'preference'); i++; }
  i = 0;
  while (i < 5000 && out.length < 220) { add(`I like to ${pick(hobbies, i, 1, 0)} ${pick(freqs, i, 3, Math.floor(i / hobbies.length))}`, 'fact'); i++; }
  i = 0;
  while (i < 5000 && out.length < 240) { add(habits[i % habits.length], 'fact'); i++; if (i >= habits.length) break; }
  i = 0;
  while (i < 5000 && out.length < 280) { add(`I use ${pick(tools, i, 1, 0)} ${pick(toolTakes, i, 5, Math.floor(i / tools.length))}`, 'preference'); i++; }
  i = 0;
  while (i < 5000 && out.length < 300) { add(opinions[i % opinions.length], 'preference'); i++; if (i >= opinions.length) break; }
  return out;
}

export const BLIND_NOISE: SavedFact[] = build();

export const BLIND_CHATS: PastChat[] = [
  { title: 'Planning Mina\'s birthday party', daysAgo: 40, user: [
    'I booked the party room at Wild Waters Rec for Saturday August 2 at 2pm, confirmation code WW-48215',
    'Budget is $350 and the theme is axolotls',
    'Mina wants a lemon-raspberry cake from Sweet Gull Bakery',
  ] },
  { title: 'Thanksgiving flights', daysAgo: 25, user: [
    'Booked Delta to Tucson for Thanksgiving, confirmation number K7QX2M',
    'We leave Wednesday November 26 at 6:40am from DLH',
    'Mom wants us to bring wild rice and a jar of the cranberry relish',
  ] },
  { title: 'Kiln and glaze troubleshooting', daysAgo: 60, user: [
    'The glaze that finally worked was Amaco Celadon mixed 3 parts to 1 part water',
    'I fired it at cone 6 with a 15 minute hold at 2232F',
    'The shelf cracked so I ordered a replacement from Bailey Ceramic Supply, order #BC-77310',
  ] },
  { title: 'Quarterly taxes', daysAgo: 18, user: [
    'I paid the Q3 estimated tax of $2,460 on September 14',
    'My accountant Ruth Engstrom says to set aside 28 percent of net',
    'Harborline pays on the 20th so I plan around that',
  ] },
  { title: 'Dishwasher repair', daysAgo: 12, user: [
    'The dishwasher is a Bosch 500 series and it keeps showing error code E24',
    'The technician Walt from Arrowhead Appliance is coming Tuesday between 1 and 3',
    'The quote is $185 for a new drain pump',
  ] },
  { title: 'Gift for Teodor\'s 45th', daysAgo: 30, user: [
    'I decided to get Teodor the Fjällräven backpack in forest green, about $170',
    'He mentioned he secretly wants a sourdough starter kit, so I will tuck that in the box',
  ] },
  { title: 'Anselm checkup notes', daysAgo: 8, user: [
    'Anselm weighed 41 pounds at his last checkup and is 43 inches tall',
    'The rule is no naps after 3pm or he will not sleep until ten',
  ] },
  { title: 'Kitchen remodel', daysAgo: 90, user: [
    'The contractor Halvard Brekke quoted $18,400 for the kitchen',
    'Start date is January 12 and the permit number is 2026-KR-0917',
    'We picked the soapstone-look quartz for the counters',
  ] },
];

export const BLIND_CASES: RecallCase[] = [
  { ask: 'text my hubby that ill be 20 min late', need: ['Teodor Achterberg'] },
  { ask: 'whats my husbands number', need: ['218-555-0147'] },
  { ask: 'need to email the kids pediatrician about anselm\'s rash, whats their phone', need: ['218-555-0192'] },
  { ask: 'can our sitter do friday night? draft a text to her', need: ['Colette Vandermeer', '218-555-0126'] },
  { ask: 'how much do i owe the sitter for 5 hours', need: ['$22 an hour'] },
  { ask: 'recpie ideas for a dinner party saturday', need: ['allergic to shellfish and tree nuts', 'vegetarian'] },
  { ask: 'good lunch spots near me', need: ['Duluth'] },
  { ask: 'is pad thai safe for me to order?', need: ['shellfish'] },
  { ask: 'what should i pack for mina\'s lunch this week', need: ['Mina doesn\'t eat mushrooms'] },
  { ask: 'draft an invoice email to my marine client', need: ['Harborline Marine', 'gudrun@harborline.example'] },
  { ask: 'how much should i quote for 6 hrs of bookkeeping', need: ['$65 an hour'] },
  { ask: 'when is the mortgage due again', need: ['due on the 3rd'] },
  { ask: 'who do i call for the subaru oil change', need: ['Gopher Auto'] },
  { ask: 'wats my plate number', need: ['JNK 4471'] },
  { ask: 'whats the number for biscuits vet', need: ['218-555-0158'] },
  { ask: 'remind me about ferdinand\'s medicine', need: ['thyroid pill every morning at 7'] },
  { ask: 'cant make my swim tomorrow, which days do i usually go?', need: ['Tuesday and Thursday at 6am'] },
  { ask: 'when do i usually fire the kiln', need: ['Sunday evenings'] },
  { ask: 'anniversary dinner ideas, its coming up', need: ['September 12'] },
  { ask: 'party gift ideas for the birthday girl', need: ['July 30'] },
  { ask: 'write my brother an email about thanksgiving plans', need: ['casimir.a@fastmail.example'] },
  { ask: 'call my mom - whats her phone', need: ['520-555-0173'] },
  { ask: 'whats the door code for the studio', need: ['7391'] },
  { ask: 'insurance member id pls', need: ['BNX-908-2217'] },
  { ask: 'write a short thank-you email and sign it the way i usually do', need: ['I sign emails Bron'] },
  { ask: 'describe my usual coffee order for the new barista', need: ['oat-milk cortado'] },
  { ask: 'whats my dentists phone', need: ['218-555-0110'] },
  { ask: 'whats the weather look like in my city this week', need: ['Duluth'] },
  { ask: 'summer 2027 trip - remind me what we planned', need: ['Vancouver Island'] },
  { ask: 'what did i decide to get my husband for his 45th', need: ['Fjällräven backpack'] },

  { earlier: ['can you help me plan a sitter schedule for next week?'], ask: 'whats her number again', need: ['218-555-0126'] },
  { earlier: ['I need to message the school about early pickup'], ask: 'which teacher is it again', need: ['Mr. Haskell'] },
  { earlier: ['draft a reminder to book a checkup for the dog'], ask: 'add their phone number', need: ['218-555-0158'] },
  { earlier: ['write an invoice for my orthodontics client'], ask: 'where do i send it', need: ['billing@northshoreortho.example'] },
  { earlier: ['planning dinner with the in-laws on sunday'], ask: 'anything i should leave out?', need: ['vegetarian'] },
  { earlier: ['im booking a table for lunch'], ask: 'make it near the studio', need: ['Canal Park Drive'] },
  { earlier: ['how do i pay my quarterly estimated tax online'], ask: 'how much did i pay last time', need: ['$2,460'] },
  { earlier: ['thinking about gifts for my husband'], ask: 'when is his birthday again', need: ['November 2'] },
  { earlier: ['my cat seems sluggish today'], ask: 'when is his pill due', need: ['thyroid pill'] },
  { earlier: ['write a text to the babysitter about saturday'], ask: 'mention what shes getting paid', need: ['$22 an hour'] },

  { ask: 'what was the confirmation code for the party room', need: ['WW-48215'] },
  { ask: 'what time is the party again', need: ['Saturday August 2 at 2pm'] },
  { ask: 'my flight confirmation number?', need: ['K7QX2M'] },
  { ask: 'when do we leave for tucson', need: ['November 26 at 6:40am'] },
  { ask: 'what ratio did i use for the celadon glaze', need: ['3 parts to 1 part water'] },
  { ask: 'whats the order number for the kiln shelf replacement', need: ['BC-77310'] },
  { ask: 'what error code was the dishwasher showing', need: ['E24'] },
  { ask: 'when is the appliance guy coming', need: ['Tuesday between 1 and 3'] },
  { ask: 'what did the contractor quote for the kitchen', need: ['$18,400'] },
  { ask: 'whats the permit number for the remodel', need: ['2026-KR-0917'] },
];

export const BLIND_NEGATIVE: NegativeCase[] = [
  { ask: 'fix this Python class, its __init__ raises a TypeError', mustNot: ['218-555-0147'] },
  { ask: 'what is a home page', mustNot: ['214 Tamarack Lane'] },
  { ask: 'what are the heart rate zones for running', mustNot: ['Heritage Center'] },
  { ask: 'what is an IP address', mustNot: ['BlueNorth'] },
  { ask: 'how to grade an essay rubric', mustNot: ['Lakeview Elementary'] },
  { ask: 'give me a report to the committee template', mustNot: ['Kiln & Ledger'] },
  { ask: 'explain how mortgage amortization works', mustNot: ['$1,840'] },
  { ask: 'what oil is best for seasoning a cast iron pan', mustNot: ['Gopher Auto'] },
  { ask: 'how do greyhounds differ from whippets', mustNot: ['Biscuit'] },
  { ask: 'what is the capital of Minnesota', mustNot: ['214 Tamarack Lane'] },
  { ask: 'what are common signs of anaphylaxis', mustNot: ['EpiPen'] },
  { ask: 'write a SQL query to join orders and customers', mustNot: ['Harborline Marine'] },
  { ask: 'how do you make a good cortado at home', mustNot: ['oat-milk cortado'] },
  { ask: 'write a polite payment reminder email template', mustNot: ['gudrun@harborline.example'] },
  { ask: 'what is the difference between a pediatrician and a family doctor', mustNot: ['Dr. Ines Marchetti'] },
  { ask: 'how much do babysitters usually charge in the US', mustNot: ['Colette Vandermeer'] },
  { ask: 'write a haiku about autumn', mustNot: ['Teodor'] },
  { ask: 'explain what a pyrometric cone is', mustNot: ['cone 04'] },
  { ask: 'translate good morning into Spanish', mustNot: ['Odalys'] },
  { ask: 'how do I calculate quarterly estimated taxes in general', mustNot: ['Range Credit Union'] },
  { ask: 'how do I stop a leaky faucet', mustNot: ['7391'] },
  { ask: 'what are fun party games for 9 year olds', mustNot: ['July 30'] },
  { ask: 'convert 350 F to Celsius', mustNot: ['JNK 4471'] },
  { ask: 'whats the best way to learn swimming laps efficiently', mustNot: ['Tuesday and Thursday at 6am'] },
  { ask: 'summarize the plot of Moby Dick', mustNot: ['Vancouver Island'] },
];
