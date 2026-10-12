import attendance from "./attendance.js";
import absentees from "./absentees.js";

// Add a report: create server/reports/<name>.js (same shape as attendance.js) and list it here.
export const reports = new Map([attendance, absentees].map((r) => [r.id, r]));
