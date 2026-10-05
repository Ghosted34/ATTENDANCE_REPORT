import { query } from "../db/pool.js";

// Times are stored in UTC. @tz shifts them to local time; the UTC window for the chosen
// local day is computed once so an index on EventUTCTime can still be used.
const SQL = `
DECLARE @d DATE = CAST(@day AS DATE);
DECLARE @from DATETIME = DATEADD(HOUR, -@tz, CAST(@d AS DATETIME));
DECLARE @to DATETIME = DATEADD(DAY, 1, @from);

SELECT
  eh.PeopleID, pp.Firstname, pp.Lastname, pp.Department,
  MIN(eh.CardNumber) AS CardNumber,
  CONVERT(VARCHAR(8), DATEADD(HOUR, @tz, MIN(eh.EventUTCTime)), 108) AS FirstEntry,
  CONVERT(VARCHAR(8), DATEADD(HOUR, @tz, MAX(eh.EventUTCTime)), 108) AS LastEntry,
  DATEDIFF(MINUTE, MIN(eh.EventUTCTime), MAX(eh.EventUTCTime)) AS DurationMin,
  COUNT(*) AS AccessCount
FROM dbo.EventHistory AS eh
LEFT JOIN dbo.p_people AS pp ON eh.PeopleID = pp.PeopleID
WHERE eh.EventCategory = 10001
  AND eh.EventDescription = 'Access Granted'
  AND eh.CardNumber IS NOT NULL AND eh.CardNumber <> 0
  AND eh.EventUTCTime >= @from AND eh.EventUTCTime < @to
GROUP BY eh.PeopleID, pp.Firstname, pp.Lastname, pp.Department;`;

export default {
  id: "attendance",
  title: "Daily attendance",
  description: "Who swiped in on a given day, with first and last entry.",
  params: [{ name: "date", label: "Date", type: "date" }],
  groupBy: "department",
  columns: [
    { key: "name", label: "Name" },
    { key: "peopleId", label: "People ID" },
    { key: "cardNumber", label: "Card no." },
    { key: "firstEntry", label: "First entry" },
    { key: "lastEntry", label: "Last entry" },
    { key: "duration", label: "Duration" },
    { key: "accessCount", label: "Swipes", align: "right" },
  ],
  subtitle: ({ date }) => `Attendance for ${date}`,

  async run({ date }, { tz }) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)))
      throw Object.assign(new Error("Pick a valid date."), { status: 400 });

    const rows = await query(SQL, { day: date, tz });
    return rows.map((r) => {
      const single = r.DurationMin === 0; // one swipe: no check-out to show
      return {
        name: [r.Lastname, r.Firstname].filter(Boolean).join(" ") || "Unknown",
        peopleId: r.PeopleID ?? "—",
        department: r.Department || "Unassigned",
        cardNumber: r.CardNumber,
        firstEntry: r.FirstEntry,
        lastEntry: single ? "—" : r.LastEntry,
        duration: single ? "—" : `${Math.floor(r.DurationMin / 60)}h ${String(r.DurationMin % 60).padStart(2, "0")}m`,
        accessCount: r.AccessCount,
      };
    }).sort((a, b) => a.department.localeCompare(b.department) || a.name.localeCompare(b.name));
  },
};
