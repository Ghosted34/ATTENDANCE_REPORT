import attendance from "./attendance.js";

// Add a report: create server/reports/<name>.js (same shape as attendance.js) and list it here.
export const reports = new Map([attendance].map((r) => [r.id, r]));
