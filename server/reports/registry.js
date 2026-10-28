// The list of reports the app offers, in the order they appear on the home screen.
// To add a report: create server/reports/<name>.js, import it here and add it to the list.
// To remove one: delete it from the list (and its file). See REPORTS.md.

import attendance from "./attendance.js";
import absentees from "./absentees.js";
import attendanceSummary from "./attendance-summary.js";
import punctuality from "./punctuality.js";

export const reports = new Map([attendance, absentees, attendanceSummary, punctuality].map((r) => [r.id, r]));
