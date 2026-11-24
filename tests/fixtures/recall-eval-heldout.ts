import type { RecallCase } from './recall-eval'

// Held-out cases written blind to the matching code: varied phrasing, typos, shorthand, indirect needs.
export const HELDOUT: RecallCase[] = [
  // Relations and nicknames
  { ask: 'text the missus that dinner is at 7', need: ['priya.shah@fastmail.com'] },
  { ask: 'email the guy who owns our building, the hallway light is out', need: ['mike@delgadoproperties.com'] },
  { ask: 'ping my supervisor that im out sick thurs', need: ['dana.whitfield@northwind.io'] },
  { ask: 'what grade is my kiddo in?', need: ['4th grade'] },
  { ask: "who's my kid's homeroom teacher?", need: ['Ms. Ortega'] },
  { ask: 'whats my brothers name again and where does he live', need: ['Neil', 'Seattle'] },
  { ask: 'what time zone am i in', need: ['Pacific time'] },
  { ask: 'give me the number for the tooth doctor', need: ['(503) 555-0142'] },
  { ask: 'my pup needs a checkup, who do I call', need: ['Hawthorne Animal Clinic'] },
  { ask: 'whats the name of my dog', need: ['Biscuit'] },
  { ask: 'call mum, what day do I usually do that?', need: ['Sundays'] },
  { ask: 'where does my mom live, looking at flights', need: ['Phoenix'] },
  // Indirect needs
  { ask: 'can I order the shrimp tacos?', need: ['shellfish'] },
  { ask: 'is the clam chowder ok for me', need: ['shellfish'] },
  { ask: 'grab me a latte from the cafe', need: ['oat-milk flat white'] },
  { ask: 'which airline should I look at for the Boise trip', need: ['Alaska Airlines'] },
  { ask: 'whats good for lunch on a tuesday', need: ['Vegetarian on weekdays'] },
  { ask: 'my hourly number for a quote to a new client?', need: ['$145'] },
  { ask: 'where do i send invoices for the studio gig', need: ['ap@brightleaf.studio'] },
  { ask: 'what day is our anniversery', need: ['June 14'] },
  { ask: 'when is priyas bday, need a gift idea', need: ['September 3'] },
  { ask: 'whats my work address for the shipping form? i mean home, sorry', need: ['418 Alder St #3B'] },
  { ask: 'where does book club meet', need: ["Powell's"] },
  { ask: 'which gym do I go to and when', need: ['Fit Republic', '6:30 AM'] },
  // Short follow-ups relying on earlier messages
  { ask: 'and cc her too', need: ['priya.shah@fastmail.com'], earlier: ['Write a quick note to my spouse saying I love her'] },
  { ask: 'forward that to him', need: ['dana.whitfield@northwind.io'], earlier: ['Summarize the launch plan for the person I report to'] },
  { ask: 'same for the car', need: ['Subaru Outback'], earlier: ['Remind me when my registration renews for the other vehicle'] },
  { ask: 'ok send it', need: ['mike@delgadoproperties.com'], earlier: ['Write up a complaint about the dripping faucet to the landlord guy'] },
  { ask: 'what about for her bday?', need: ['September 3'], earlier: ['Plan a surprise for my wife'] },
  { ask: 'whos the vet there', need: ['Hawthorne Animal Clinic'], earlier: ['Biscuit has been limping since yesterday'] },
  { ask: 'and how much for that one?', need: ['$21,900'], earlier: ['Remind me which of the kitchen bids was the priciest'] },
  { ask: 'put that on his invoice', need: ['ap@brightleaf.studio'], earlier: ['Log 5 hours of work for the studio client today'] },
  // Past-chat-only content
  { ask: 'what was the invoice number I used for Brightleaf?', need: ['2024-117'] },
  { ask: 'when do we fly to Portugal?', need: ['March 12 to March 19'] },
  { ask: 'what airport do we leave from for the Lisbon flight', need: ['Newark'] },
  { ask: 'what router do I have', need: ['Eero Pro 6'] },
  { ask: 'what time does soccer end on wed', need: ['5:15'] },
  { ask: 'how long should my weekly update be', need: ['under 200 words'] },
  { ask: 'who gave the middle quote for the kitchen', need: ['Oakline'] },
  { ask: 'when can Rivera start work?', need: ['January'] }
]
