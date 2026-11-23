// The "don't make me repeat myself" eval (tests/unit/recall-eval.test.ts): one realistic user, the facts
// they told SahilBot over a few months (saved memories and plain chat messages), and follow-up requests
// phrased the way people actually ask, which lean on those facts without restating them ("email my
// landlord about the leak", "book the usual", "send it to my wife"). Each case lists the words that must
// reach the run for the bot to do the job without asking again.

export interface SavedFact { text: string; category: string }
export interface PastChat { title: string; daysAgo: number; user: string[] }
export interface RecallCase {
  /** What the user types now. */
  ask: string
  /** Every one of these must be in what the run gets (or what one memory search finds). */
  need: string[]
  /** Earlier messages in this same chat, when the ask points back to them ("send it to her"). */
  earlier?: string[]
}

/** What the user told SahilBot that the cases rely on. */
export const KEY_FACTS: SavedFact[] = [
  { text: 'My wife is Priya Shah, her email is priya.shah@fastmail.com', category: 'person' },
  { text: 'Landlord: Mike Delgado, mike@delgadoproperties.com, rents us the apartment at 418 Alder St #3B', category: 'person' },
  { text: 'Son Arjun is in 4th grade at Lincoln Elementary; his teacher is Ms. Ortega', category: 'person' },
  { text: 'Manager at work is Dana Whitfield (dana.whitfield@northwind.io)', category: 'person' },
  { text: 'Lives in Portland, Oregon (Pacific time)', category: 'location' },
  { text: 'Home address: 418 Alder St #3B, Portland, OR 97205', category: 'location' },
  { text: 'Usual coffee order: large oat-milk flat white, no sugar', category: 'preference' },
  { text: 'Prefers aisle seats and Alaska Airlines; Mileage Plan number on file in the vault', category: 'preference' },
  { text: 'Allergic to shellfish', category: 'profile' },
  { text: 'Vegetarian on weekdays', category: 'preference' },
  { text: 'Works as a product manager at Northwind Analytics', category: 'work' },
  { text: 'Dentist is Dr. Lena Park at Pearl Dental, (503) 555-0142', category: 'person' },
  { text: 'Car: 2019 Subaru Outback, plate 7KJ-402', category: 'fact' },
  { text: 'Gym: Fit Republic on Burnside, Tuesday and Thursday 6:30 AM', category: 'fact' },
  { text: 'Mom Asha lives in Phoenix; call her Sundays', category: 'person' },
  { text: 'Freelance client Brightleaf Studio pays net 30; invoices go to ap@brightleaf.studio', category: 'work' },
  { text: 'Hourly consulting rate is $145', category: 'work' },
  { text: 'Wedding anniversary is June 14', category: 'date' },
  { text: 'Priya\'s birthday is September 3', category: 'date' },
  { text: 'Wants short answers with bullet points, no long intros', category: 'preference' },
  { text: 'Dog is Biscuit, a corgi; vet is Hawthorne Animal Clinic', category: 'fact' },
  { text: 'Kitchen sink in the apartment has leaked twice since August', category: 'fact' },
  { text: 'Book club meets the first Wednesday of the month at Powell\'s', category: 'fact' },
  { text: 'Uses Fidelity for the 401k and Ally for savings', category: 'fact' },
  { text: 'Brother Neil lives in Seattle and works at Boeing', category: 'person' }
]

/** Things saved over months that have nothing to do with the cases (so ranking and budget matter). */
export const NOISE_FACTS: SavedFact[] = [
  'Likes sci-fi novels, especially Ursula K. Le Guin', 'Favorite band is Khruangbin', 'Learning Spanish on Duolingo, 140-day streak',
  'Hates cilantro', 'Prefers dark mode in every app', 'Running a 10K in April', 'Has a standing desk at home', 'Watching Severance season 2',
  'Wants to repaint the bedroom sage green', 'Owns a Vitamix blender', 'Plays pickleball on Saturdays', 'Prefers Google Docs over Word',
  'Bought a Kindle Paperwhite last year', 'Interested in sourdough baking', 'Has a 5-year-old MacBook Pro', 'Grew up in Ahmedabad',
  'Graduated from Oregon State in 2012', 'Takes the MAX red line to work on Mondays', 'Loves Thai food from Pok Pok', 'Follows the Trail Blazers',
  'Planning to buy an e-bike', 'Keeps a gratitude journal', 'Tried the Whole30 diet in 2023', 'Prefers Celsius for weather', 'Wants to visit Kyoto',
  'Uses 1Password', 'Owns an Instant Pot', 'Subscribed to The Atlantic', 'Prefers PDFs for reports', 'Likes board games, especially Wingspan',
  'Volunteers at the food bank twice a year', 'Wants to learn to sail', 'Has a vegetable garden with tomatoes and basil', 'Drinks matcha in the afternoon',
  'Watches F1 on Sundays', 'Prefers metric units for cooking', 'Hikes Forest Park often', 'Considering a Tesla Model Y', 'Reads the Morning Brew newsletter',
  'Keeps receipts in a Google Drive folder', 'Prefers email over phone calls', 'Took a pottery class last spring', 'Wants a quieter mechanical keyboard',
  'Uses Notion for personal projects', 'Listens to the Hard Fork podcast', 'Prefers window seats on trains', 'Owns a Weber grill', 'Collects vinyl records',
  'Likes the Oregon coast, especially Cannon Beach', 'Took a road trip to Crater Lake in 2022', 'Prefers spreadsheets with frozen header rows',
  'Thinking about a home espresso machine', 'Uses an iPhone 15', 'Likes Ghibli films', 'Bakes banana bread on weekends', 'Sleeps around 11 PM',
  'Wants a reminder before quarterly taxes', 'Prefers USPS over UPS for small packages', 'Likes jazz while working', 'Practicing yoga on Fridays'
].map((text) => ({ text, category: 'fact' }))

/** Earlier chats with the same bot: only the user's words (the facts weren't saved as memories). */
export const PAST_CHATS: PastChat[] = [
  { title: 'Brightleaf invoice', daysAgo: 9, user: ['Make an invoice for Brightleaf Studio for 12 hours of research work in October', 'Use invoice number 2024-117 and put my PO reference BL-5582 on it'] },
  { title: 'Kitchen remodel quotes', daysAgo: 20, user: ['I got three quotes for the kitchen: Rivera Builders $18,400, Oakline $21,900 and HomeCraft $16,750. We are leaning toward Rivera because they can start in January'] },
  { title: 'Lisbon trip', daysAgo: 35, user: ['We are going to Lisbon from March 12 to March 19, staying at Memmo Alfama', 'Our flight is TAP 218 out of Newark'] },
  { title: 'Router reset', daysAgo: 50, user: ['My wifi network is called AlderNest and the router is an Eero Pro 6'] },
  { title: 'School pickup', daysAgo: 4, user: ['Arjun has soccer practice Wednesdays until 5:15 at Wallace Park, so pickup is there instead of school'] },
  { title: 'Weekly report', daysAgo: 13, user: ['For my weekly report to Dana I always include: shipped, in progress, blocked, and next week. Keep it under 200 words'] }
]

export const CASES: RecallCase[] = [
  // People named by their relation
  { ask: 'Email my landlord about the sink leaking again', need: ['mike@delgadoproperties.com'] },
  { ask: 'Send my wife a note that I\'ll be late tonight', need: ['priya.shah@fastmail.com'] },
  { ask: 'Draft a message to my boss asking for Friday off', need: ['dana.whitfield@northwind.io'] },
  { ask: 'Write a thank-you note to my son\'s teacher', need: ['Ortega'] },
  { ask: 'Book a cleaning with my dentist', need: ['Pearl Dental'] },
  { ask: 'Remind me to call my mother this weekend', need: ['Sunday'] },
  { ask: 'What does my brother do for work again?', need: ['Boeing'] },
  { ask: 'Find a birthday gift for my wife', need: ['September 3'] },
  { ask: 'Make an appointment for the dog at the vet', need: ['Hawthorne'] },
  // Preferences and "the usual"
  { ask: 'Order my usual coffee for pickup', need: ['oat-milk flat white'] },
  { ask: 'Find me a flight to Seattle next Friday', need: ['aisle'] },
  { ask: 'Book a dinner spot for our anniversary', need: ['June 14', 'shellfish'] },
  { ask: 'Suggest a quick weeknight dinner recipe', need: ['Vegetarian on weekdays'] },
  { ask: 'Plan meals for next week', need: ['shellfish'] },
  { ask: 'What\'s a good restaurant near my place for Friday?', need: ['Alder St'] },
  // Where they live and their stuff
  { ask: 'What\'s the weather going to be like tomorrow?', need: ['Portland'] },
  { ask: 'Ship this package to my home address', need: ['97205'] },
  { ask: 'Schedule an oil change for my car', need: ['Subaru'] },
  { ask: 'Move my gym session tomorrow to the evening', need: ['Fit Republic'] },
  { ask: 'When is my book club this month?', need: ['first Wednesday'] },
  // Work
  { ask: 'Invoice Brightleaf for 8 more hours', need: ['ap@brightleaf.studio', '$145'] },
  { ask: 'Write my weekly report for this week', need: ['shipped, in progress, blocked'] },
  { ask: 'When should I expect payment from that client?', need: ['net 30'], earlier: ['I sent the Brightleaf invoice yesterday'] },
  { ask: 'Use the same PO reference as last time on the new Brightleaf invoice', need: ['BL-5582'] },
  // Things said only in chat
  { ask: 'Which kitchen contractor did we pick, and what was their price?', need: ['Rivera', '18,400'] },
  { ask: 'What hotel are we staying at in Lisbon?', need: ['Memmo Alfama'] },
  { ask: 'Check the status of our flight to Lisbon', need: ['TAP 218'] },
  { ask: 'Where do I pick up Arjun on Wednesday?', need: ['Wallace Park'] },
  { ask: 'What\'s my wifi called again?', need: ['AlderNest'] },
  { ask: 'Which quote was the cheapest for the kitchen?', need: ['HomeCraft'] },
  // Short follow-ups that point back
  { ask: 'send it to her', need: ['priya.shah@fastmail.com'], earlier: ['Write a sweet anniversary card message for my wife'] },
  { ask: 'cc him on that', need: ['dana.whitfield@northwind.io'], earlier: ['Draft an update to my manager about the Q4 roadmap'] },
  { ask: 'do the same for the dog', need: ['Hawthorne'], earlier: ['Add my dentist appointment reminders to my calendar'] },
  { ask: 'tell him about it', need: ['mike@delgadoproperties.com'], earlier: ['The kitchen sink is leaking again under the cabinet, my landlord needs to know'] },
  // Mixed and indirect
  { ask: 'Is it safe for me to eat paella?', need: ['shellfish'] },
  { ask: 'How much should I charge for a 3-hour workshop?', need: ['$145'] },
  { ask: 'Keep it short like I like', need: ['short answers'] },
  { ask: 'Draft a text to the kid\'s school saying he\'ll be absent tomorrow', need: ['Lincoln Elementary'] },
  { ask: 'Where does my retirement money sit?', need: ['Fidelity'] },
  { ask: 'Tell the property manager the leak is back', need: ['mike@delgadoproperties.com'] }
]
