// Realistic sample documents for the docs quality screenshots (tests/tools/docs-quality-shot.test.ts):
// a ~6-page business report, a one-page memo, a resume, an invoice, a slide deck and a financial model.
// Each is a create_document spec (paths are relative to the output folder). Options a generator doesn't
// know are ignored, so the same specs render with older code for before/after comparisons.

export interface Sample { name: string; spec: Record<string, unknown> }

const REPORT = `# Northwind Retail: FY2026 Operating Review

## Executive summary

Northwind closed FY2026 with **$48.2M in revenue (+14% year over year)** and an operating margin of 11.8%, up 2.1 points. Growth came from the West region and the new subscription line, which reached 31,400 members in nine months. Inventory turns slipped from 6.1 to 5.4 because the Q3 holiday buy landed early; we recommend a tighter open-to-buy process and a 90-day markdown cadence before Q1 FY2027.

> [!IMPORTANT] Recommendation: approve the $2.4M fulfilment investment in Reno. It pays back in 19 months at current volumes and removes the West region's two-day delivery gap.

[TOC]

## 1. Financial performance

Revenue grew in every quarter, with the strongest lift in Q4 when the subscription line and holiday traffic overlapped. Gross margin held at 41% despite freight costs rising 9%, because the price changes made in February — the first in three years — stuck without hurting conversion.[^price]

Table: Quarterly results ($K)

| Quarter | Revenue | Gross profit | Gross margin | Operating income | YoY growth |
|---|---:|---:|---:|---:|---:|
| Q1 FY2026 | 10,420 | 4,272 | 41.0% | 1,084 | 9.8% |
| Q2 FY2026 | 11,150 | 4,571 | 41.0% | 1,227 | 12.1% |
| Q3 FY2026 | 12,060 | 4,944 | 41.0% | 1,447 | 15.3% |
| Q4 FY2026 | 14,570 | 5,974 | 41.0% | 1,930 | 18.2% |
| **Total** | **48,200** | **19,761** | **41.0%** | **5,688** | **14.0%** |

\`\`\`chart
{"type": "column", "title": "Revenue by quarter ($K)", "categories": ["Q1", "Q2", "Q3", "Q4"], "series": [{"name": "FY2025", "values": [9490, 9946, 10460, 12327]}, {"name": "FY2026", "values": [10420, 11150, 12060, 14570]}], "number_format": "$#,##0"}
\`\`\`

Operating expenses rose 8%, slower than revenue, so the margin expanded. The largest increases were marketing (+$610K, mostly the subscription launch) and warehouse labour (+$420K). General and administrative costs were flat.

### Cost structure

- **Cost of goods sold** fell to 59.0% of revenue from 59.6%, helped by the February price change and better supplier terms on the top 40 SKUs.
- **Freight** rose to 6.2% of revenue. Carrier surcharges in Q3 added about $180K that we do not expect to recur.
- **Marketing** was 7.4% of revenue. Customer acquisition cost for subscribers was $38 against a first-year value of $142.
  - Paid social drove 46% of new subscribers.
  - Referral codes drove 21%, at a third of the cost.

## 2. Regional performance

The West region grew fastest, while the East stayed the largest. The Central region was flat after the Omaha store closed in May; excluding it, Central grew 6%.

Table: Revenue and growth by region

| Region | Stores | Revenue ($K) | Share | YoY growth | Same-store growth | Net promoter score |
|---|---:|---:|---:|---:|---:|---:|
| East | 14 | 18,316 | 38% | 9% | 7% | 61 |
| West | 11 | 15,906 | 33% | 24% | 19% | 58 |
| Central | 9 | 8,676 | 18% | 1% | 6% | 55 |
| South | 6 | 5,302 | 11% | 17% | 15% | 63 |

![Reno fulfilment centre site plan](site-plan.png "Proposed Reno fulfilment centre, 82,000 sq ft, with room to expand to 120,000 sq ft")

The Reno site sits 14 minutes from the I-80 interchange. Moving West-region fulfilment there cuts the average delivery time from 3.4 days to 1.6 days for 78% of West customers, based on the carrier's zone map.

## 3. Customers and the subscription line

Northwind Plus launched in February at $9.99 a month. Members get free two-day shipping, early access to sales and a monthly credit. By year end:

1. 31,400 active members, against a plan of 25,000.
2. Monthly churn of 3.1%, falling to 2.2% for members who used the monthly credit at least twice.
3. Members spent 2.7× as much as non-members in the same period (a selection effect we are still measuring).

> "The subscription changed how often we hear from our best customers: weekly instead of seasonally."
> — Dana Whitfield, VP Customer

Members are concentrated in the West and South, which is one reason fulfilment speed there matters more than it did a year ago. Café owners, teachers and small-office managers make up 44% of members — a B2B-like segment we had not targeted directly.

## 4. Operations

Inventory turns fell to 5.4. The holiday buy arrived three weeks early, which raised average inventory in Q3 by $1.9M. Stock-outs on the top 200 SKUs stayed under 2% all year.

Table: Operating metrics

| Metric | FY2025 | FY2026 | Target FY2027 | Status |
|---|---:|---:|---:|---|
| Inventory turns | 6.1 | 5.4 | 6.0 | Below target |
| Stock-out rate (top 200 SKUs) | 2.4% | 1.8% | 1.5% | On track |
| Average delivery time (days) | 3.1 | 3.0 | 2.0 | Needs Reno |
| Order accuracy | 99.1% | 99.4% | 99.5% | On track |
| Return rate | 7.9% | 7.2% | 7.0% | On track |
| Warehouse cost per order | $4.82 | $4.95 | $4.40 | Needs Reno |
| On-time supplier deliveries | 88% | 91% | 95% | Improving |
| Employee turnover (warehouse) | 41% | 34% | 28% | Improving |
| Pick rate (units/hour) | 96 | 104 | 120 | Improving |
| Damaged-in-transit rate | 1.2% | 0.9% | 0.8% | On track |

> [!WARNING] The current warehouse in Sacramento is at 94% of usable capacity. Without Reno, we will need overflow storage by March at roughly $65K a month.

The warehouse management system upgrade went live in August. Picking accuracy improved immediately; the configuration we use for the pick-path optimisation is below for the operations team's reference.

\`\`\`yaml
pick_path:
  strategy: s-shape
  batch_size: 18
  zones: [A, B, C, cold]
  priority: ["same-day", "plus-member", "standard"]
\`\`\`

## 5. Risks

- **Concentration:** the top supplier provides 22% of COGS. A second source for the top 30 SKUs is in negotiation.
- **Labour:** warehouse wages rose 6.5%; Reno's labour market is tighter than Sacramento's.
- **Subscription economics:** if churn rises above 4% a month, the programme stops paying for its shipping cost.
- **Leases:** four store leases renew in FY2027; two landlords have asked for increases above 10%.
- **Sourcing:** two ceramics suppliers in Kyoto (京都陶器) and Malmö price in local currency; a 10% yen or krona move shifts landed cost by about ±0.4 points.

## 6. Recommendations and next steps

1. Approve the Reno fulfilment centre ($2.4M capital, $310K annual operating savings plus the delivery-time gain).
2. Introduce a 90-day markdown cadence and a monthly open-to-buy review to bring inventory turns back to 6.0.
3. Build a small-business offer inside Northwind Plus, starting with café and office bundles.
4. Re-tender freight before the Q3 peak; three carriers have quoted 6–8% below the incumbent.

Table: Next steps

| Action | Owner | Due | Investment |
|---|---|---|---:|
| Reno lease signature and fit-out tender | COO | Jan 15 | $2,400,000 |
| Markdown cadence and open-to-buy policy | Merchandising | Feb 1 | — |
| Northwind Plus for Business pilot (200 accounts) | VP Customer | Mar 1 | $85,000 |
| Freight re-tender | Logistics | Apr 30 | — |

[^price]: Average price rose 3.8%. Conversion was 2.91% before and 2.94% after the change (four weeks each side, excluding promotions).
`

const MEMO = `Over the last two quarters our cloud bill grew 38% while traffic grew 12%. Most of the gap is idle staging capacity and an analytics cluster sized for last year's peak. This memo asks for approval to move to reserved capacity and to switch off three environments nobody has used since July.

## What changes

- Staging runs 07:00–20:00 on weekdays instead of around the clock (saves about $9,400 a month).
- The analytics cluster moves from 24 to 12 nodes, with autoscaling up to 20 for month-end reports.
- We buy one-year reserved capacity for the production database and API tier (saves 31% on those lines).

Table: Expected monthly savings

| Item | Today | After | Saving |
|---|---:|---:|---:|
| Staging environments | $14,100 | $4,700 | $9,400 |
| Analytics cluster | $22,800 | $13,300 | $9,500 |
| Reserved capacity (prod) | $31,500 | $21,700 | $9,800 |
| **Total** | **$68,400** | **$39,700** | **$28,700** |

## Risks

Month-end reporting could slow down if autoscaling lags; we'll run the October close in parallel on the old cluster to compare. Reserved capacity is a one-year commitment of $260,000, which is below our lowest monthly run rate in the past 18 months.

## Decision needed

Please approve by **Friday, November 21** so the reservations apply from December 1. Questions to Priya Natarajan (ext. 4417).`

const RESUME = `# Maya Okafor

maya.okafor@example.com · (415) 555-0142 · San Francisco, CA · linkedin.com/in/mayaokafor

## Summary

Product designer with 9 years of experience shipping consumer and B2B software. I lead research-driven redesigns, build design systems that engineers like using, and measure the results — most recently a checkout redesign that lifted conversion 11%.

## Experience

### Lead Product Designer — Lumen Health | 2022 – Present

- Led the redesign of the patient intake flow used by 1.2M people a year; completion rose from 64% to 81%.
- Built the Lumen design system (140 components, React and Figma) and cut UI build time by roughly a third.
- Hired and mentored a team of four designers; two have since been promoted.

### Senior Product Designer — Parcelly | 2019 – 2022

- Owned checkout and payments; a simplified checkout lifted conversion 11% and reduced support tickets 18%.
- Ran 60+ usability sessions a year and set up the company's first research repository.

### Product Designer — Brightwave Studio | 2016 – 2019

- Designed mobile apps for retail and travel clients, including a booking app with a 4.8-star rating.

## Education

### B.F.A. Interaction Design — California College of the Arts | 2016

## Skills

- **Design:** product strategy, interaction design, prototyping, design systems, accessibility (WCAG 2.2)
- **Research:** interviews, usability testing, surveys, analytics, A/B testing
- **Tools:** Figma, Framer, React (enough to prototype), Amplitude, Dovetail`

const INVOICE = `Table: Services

| Description | Hours | Rate | Amount |
|---|---:|---:|---:|
| Brand strategy workshop (2 sessions) | 8 | $185.00 | $1,480.00 |
| Visual identity: logo, colour and type system | 26 | $165.00 | $4,290.00 |
| Website design: 7 page templates | 34 | $165.00 | $5,610.00 |
| Front-end build and CMS setup | 41 | $150.00 | $6,150.00 |
| Project management | 9 | $120.00 | $1,080.00 |
| Subtotal | | | $18,610.00 |
| Sales tax (0% — services) | | | $0.00 |
| Total due | | | $18,610.00 |

## Payment

Pay by ACH or wire within 30 days. Bank: First Coastal Bank · Account name: Fernwood Design Studio LLC · Routing and account numbers are on the W-9 sent with the contract. Please include the invoice number with your payment.

Thank you for your business — it was a pleasure working with the Harbor & Pine team.`

export const SAMPLES: Sample[] = [
  {
    name: 'report',
    spec: {
      path: 'report.pdf', markdown: REPORT, template: 'report',
      fields: { subtitle: 'Annual operating review for the board', author: 'Finance & Strategy', organization: 'Northwind Retail', date: 'November 14, 2026' },
      citations: [{ text: 'Northwind Retail FY2026 audited management accounts, November 2026' }, { text: 'U.S. Census Bureau, Monthly Retail Trade Report, October 2026', url: 'https://www.census.gov/retail/index.html' }]
    }
  },
  { name: 'report-classic', spec: { path: 'report-classic.pdf', markdown: REPORT, template: 'report', theme: 'classic', fields: { subtitle: 'Annual operating review for the board', author: 'Finance & Strategy', organization: 'Northwind Retail', date: 'November 14, 2026' } } },
  { name: 'memo-minimal', spec: { path: 'memo-minimal.pdf', markdown: MEMO, template: 'memo', theme: 'minimal', fields: { to: 'Leadership team', from: 'Priya Natarajan, Head of Platform', cc: 'Finance', date: 'November 14, 2026', subject: 'Cutting cloud spend by $28,700 a month' } } },
  { name: 'report-docx', spec: { path: 'report.docx', markdown: REPORT, template: 'report', fields: { subtitle: 'Annual operating review for the board', author: 'Finance & Strategy', organization: 'Northwind Retail', date: 'November 14, 2026' } } },
  { name: 'memo', spec: { path: 'memo.pdf', markdown: MEMO, template: 'memo', fields: { to: 'Leadership team', from: 'Priya Natarajan, Head of Platform', cc: 'Finance', date: 'November 14, 2026', subject: 'Cutting cloud spend by $28,700 a month' } } },
  { name: 'memo-docx', spec: { path: 'memo.docx', markdown: MEMO, template: 'memo', fields: { to: 'Leadership team', from: 'Priya Natarajan, Head of Platform', cc: 'Finance', date: 'November 14, 2026', subject: 'Cutting cloud spend by $28,700 a month' } } },
  { name: 'resume', spec: { path: 'resume.pdf', markdown: RESUME, template: 'resume', page_numbers: false } },
  { name: 'invoice', spec: { path: 'invoice.pdf', markdown: INVOICE, template: 'invoice', fields: { sender: 'Fernwood Design Studio LLC', sender_address: '88 Valencia Street; San Francisco, CA 94103; billing@fernwood.example', recipient: 'Harbor & Pine Architects', recipient_address: 'Attn: Accounts Payable; 1200 Embarcadero Road, Suite 400; Palo Alto, CA 94303', invoice_number: 'INV-2026-0147', date: 'November 15, 2026', due_date: 'December 15, 2026', po_number: 'PO-88213', terms: 'Net 30' }, page_numbers: false } },
  {
    name: 'deck',
    spec: {
      path: 'deck.pptx', title: 'FY2026 Operating Review',
      slides: [
        { title: 'FY2026 Operating Review', subtitle: 'Northwind Retail · Board meeting, November 2026', layout: 'title' },
        { title: 'Revenue grew 14% to $48.2M, and margin expanded 2.1 points', layout: 'stats', stats: [{ value: '$48.2M', label: 'Revenue, +14% YoY' }, { value: '11.8%', label: 'Operating margin' }, { value: '31,400', label: 'Plus members' }, { value: '5.4', label: 'Inventory turns' }], bullets: ['Every quarter beat the prior year; Q4 was the strongest at +18%'] },
        { title: 'Q4 was the strongest quarter as Plus and holiday traffic overlapped', layout: 'chart', chart: { type: 'column', categories: ['Q1', 'Q2', 'Q3', 'Q4'], series: [{ name: 'FY2025', values: [9490, 9946, 10460, 12327] }, { name: 'FY2026', values: [10420, 11150, 12060, 14570] }], number_format: '$#,##0' }, bullets: ['Q4 revenue +18% YoY', 'Plus members spend 2.7× more'] },
        { title: 'The West grew fastest; Central was flat after the Omaha closure', layout: 'table', table: [['Region', 'Stores', 'Revenue ($K)', 'YoY growth', 'NPS'], ['East', 14, '18,316', '9%', 61], ['West', 11, '15,906', '24%', 58], ['Central', 9, '8,676', '1%', 55], ['South', 6, '5,302', '17%', 63]] },
        { title: 'Reno closes the West delivery gap', layout: 'two_column', left_title: 'Today (Sacramento)', right_title: 'With Reno', bullets: ['3.4-day average delivery in the West', 'Warehouse at 94% of capacity', '$4.95 warehouse cost per order'], right: ['1.6-day delivery for 78% of West customers', 'Room to grow to 120,000 sq ft', '$310K annual operating savings'] },
        { title: 'Operations', subtitle: 'Inventory, fulfilment and suppliers', layout: 'section' },
        { title: 'Three things to fix before Q1', bullets: ['Inventory turns fell to 5.4 because the holiday buy landed three weeks early', 'Freight rose to 6.2% of revenue; re-tender before the Q3 peak', 'Warehouse turnover is down to 34% but Reno hiring will be tighter', '  Start recruiting in January with a referral bonus'], notes: 'Spend most of the time on inventory: the markdown cadence is the decision we need.' },
        { title: 'Approve the $2.4M Reno investment', layout: 'closing', subtitle: 'Payback in 19 months · Decision needed by December 1' }
      ]
    }
  },
  {
    name: 'model',
    spec: {
      path: 'model.xlsx', title: 'Reno fulfilment model', currency: '$',
      sheets: [
        { name: 'Assumptions', rows: [['Assumption', 'Value'], ['Capital cost', 2400000], ['Annual operating savings', 310000], ['Annual volume growth', 0.12], ['Discount rate', 0.09], ['Orders per year (Y1)', 410000]], columns: [{ header: 'Assumption', type: 'text', width: 30 }, { header: 'Value', type: 'number', format: '#,##0.00' }] },
        {
          name: 'Cash flow',
          rows: [['Year', 'Orders', 'Savings', 'Capex', 'Net cash flow', 'Cumulative'], [0, 0, 0, 2400000, '=C2-D2', '=E2'], [1, 410000, 310000, 0, '=C3-D3', '=F2+E3'], [2, '=B3*1.12', '=C3*1.12', 0, '=C4-D4', '=F3+E4'], [3, '=B4*1.12', '=C4*1.12', 0, '=C5-D5', '=F4+E5'], [4, '=B5*1.12', '=C5*1.12', 0, '=C6-D6', '=F5+E6'], [5, '=B6*1.12', '=C6*1.12', 0, '=C7-D7', '=F6+E7']],
          columns: [{ header: 'Year', type: 'integer', total: 'none' }, { header: 'Orders', type: 'integer', total: 'sum' }, { header: 'Savings', type: 'currency', total: 'sum' }, { header: 'Capex', type: 'currency', total: 'sum' }, { header: 'Net cash flow', type: 'currency', total: 'sum' }, { header: 'Cumulative', type: 'currency', total: 'none' }],
          totals: true, conditional: [{ column: 'Cumulative', type: 'negative' }]
        }
      ],
      summary: { title: 'Summary', items: [{ label: 'Total savings (5 years)', value: "='Cash flow'!C8", format: '$#,##0' }, { label: 'Net cash flow (5 years)', value: "='Cash flow'!E8", format: '$#,##0' }] }
    }
  }
]

/** A site plan picture (SVG) the harness rasterizes to site-plan.png for the report. */
export const SITE_PLAN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="640" viewBox="0 0 1200 640">
<rect width="1200" height="640" fill="#eef2f1"/>
<rect x="60" y="60" width="1080" height="520" fill="#dfe7e4" stroke="#9fb3ad" stroke-width="3"/>
<rect x="160" y="140" width="560" height="300" fill="#ffffff" stroke="#36514a" stroke-width="5"/>
<text x="440" y="300" font-family="Helvetica" font-size="34" text-anchor="middle" fill="#36514a">Warehouse · 82,000 sq ft</text>
<rect x="720" y="140" width="240" height="300" fill="none" stroke="#36514a" stroke-width="3" stroke-dasharray="14 10"/>
<text x="840" y="300" font-family="Helvetica" font-size="24" text-anchor="middle" fill="#5d7770">Expansion</text>
${Array.from({ length: 12 }, (_, i) => `<rect x="${180 + i * 44}" y="440" width="30" height="40" fill="#f2b84b" stroke="#a87411"/>`).join('')}
<text x="440" y="520" font-family="Helvetica" font-size="22" text-anchor="middle" fill="#36514a">12 loading docks</text>
<path d="M60 600 L1140 600" stroke="#7c8b87" stroke-width="18"/>
<text x="1000" y="570" font-family="Helvetica" font-size="22" fill="#36514a">To I-80 (14 min)</text>
</svg>`
