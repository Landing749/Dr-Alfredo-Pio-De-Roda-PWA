/**
 * OPTIONAL — Cloud Function for real push delivery.
 *
 * The PWA's client-side FCM code (js/app.js) requests permission and
 * registers a token, but a browser tab that isn't open/focused can't push
 * a notification to itself — that part has to run server-side. This
 * function does the missing half: it watches
 * schools/DAPRES/attendance/{date}/{studentId} for new writes and sends
 * an FCM push to every parent who has that student linked.
 *
 * Requires the Firebase Blaze (pay-as-you-go) plan — Cloud Functions
 * don't run on the free Spark plan. Deploy with:
 *   cd functions && npm install && firebase deploy --only functions
 * (assumes `firebase init functions` was run once in this project first,
 * targeting the dr-alfredo-pio-de-roda project.)
 */
const { onValueWritten } = require("firebase-functions/v2/database");
const { initializeApp } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");
const { getMessaging } = require("firebase-admin/messaging");

initializeApp();

exports.notifyOnAttendanceWrite = onValueWritten(
  "/schools/{schoolId}/attendance/{date}/{studentId}",
  async (event) => {
    const after = event.data.after.val();
    if (!after) return; // record deleted — nothing to notify

    const { studentId, date } = event.params;
    const db = getDatabase();

    // Find every parent who has this student linked.
    const parentsSnap = await db.ref("parents").get();
    const parents = parentsSnap.val() || {};
    const tokens = [];
    for (const [uid, pdata] of Object.entries(parents)) {
      if (pdata.students && pdata.students[studentId]) {
        const t = pdata.fcm_tokens || {};
        tokens.push(...Object.keys(t));
      }
    }
    if (!tokens.length) return;

    const name = after.student_name || "Your child";
    const title =
      after.status === "late" ? `${name} scanned in late`
      : after.status === "absent" ? `${name} marked absent`
      : `${name} scanned in on time`;
    const body =
      after.status === "absent" ? `No scan recorded for ${date}.`
      : `Scanned at ${after.time || ""} on ${date}.`;

    await getMessaging().sendEachForMulticast({
      tokens,
      notification: { title, body },
      data: { studentId, date, status: after.status || "" },
    });
  }
);
