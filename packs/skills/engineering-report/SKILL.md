---
name: engineering-report
description: Write an engineering or test report for a decision-maker with the answer first, traced requirements, units, uncertainty and calc appendices.
source: you
uses: 0
category: Engineering
triggers: engineering report, technical report, design report, test report, failure analysis report, design justification, technical memo, executive summary for engineers, compliance matrix, calculation appendix, figure and table captions, report review checklist
---

## When
Writing up a design, analysis, test or failure for someone who must decide or approve. Calcs: engineering-calculations. Requirements and verification matrices: systems-engineering. File mechanics: make-word-doc, make-pdf-report.

## Structure
1. **Title block**: title, document number, revision, date, author, reviewer.
2. **Summary (half page max)**: the answer in the first sentence, then 3-5 key numbers with units, the recommendation, and the top risk. Someone who reads only this must be able to decide.
3. **Requirements**: the ones this report addresses, with IDs and target values.
4. **Method**: what was analyzed or tested, setup, instruments with accuracy, standards followed.
5. **Assumptions and limits**: each with why it is reasonable and what changes if it is wrong.
6. **Results**: tables and plots with units and uncertainty (+/- value or range, sample size). Requirement vs result vs pass/fail.
7. **Discussion**: what the results mean, anomalies, sensitivity, alternatives rejected and why.
8. **Recommendations**: specific actions, owners, dates; open issues.
9. **References**: standards, datasheets, prior reports, with versions.
10. **Appendices**: calc sheets, raw data, test procedures, drawings.

## Writing rules
- Write for the decision-maker: conclusion first, evidence second, detail last.
- Every number has a unit and a source (calc, test, datasheet) and sensible significant figures.
- Use exact language: "deflection 1.8 mm vs 2.0 mm allowed, margin 10%", not "deflection is acceptable".
- Active voice, short paragraphs, defined acronyms, one idea per paragraph.
- Separate observations (measured) from interpretations (inferred).

## Figures and tables
- Number and caption each one; the caption states the takeaway ("Peak current stays below the 40 A breaker").
- Axes labeled with quantity and unit; legends readable; no 3D effects; consistent scales across compared plots.
- Reference every figure and table in the text; place it after its first mention.
- Tables beat prose for comparisons; right-align numbers, units in the header.

## Traceability
Include a compliance table: requirement ID, requirement, result, method, evidence (section, appendix or file), status. Every conclusion points to evidence; every requirement in scope appears.

## Steps
1. Collect requirements, data and calc scripts; rerun calcs so numbers are current.
2. Draft the summary first, then fill sections to support it; rewrite the summary last.
3. Build it with create_document (docx or pdf; report template for cover and contents), run review_document, fix every FAIL, and reopen the file to confirm figures and tables rendered.

## Review checklist
- Answer and recommendation in the first paragraph?
- Every requirement in scope has a result and status?
- Units, uncertainty and sources on every number? Totals add up?
- Assumptions listed and tested for sensitivity where they matter?
- Figures captioned, referenced, labeled?
- Revision and reviewer recorded; terms and acronyms defined?

## Pitfalls
Burying the answer on page 9; results without uncertainty or sample size; screenshots of spreadsheets instead of tables; conclusions not supported by data; silent changes between revisions (add a change log).
