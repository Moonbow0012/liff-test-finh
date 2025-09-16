const { onObjectFinalized } = require("firebase-functions/v2/storage");
const sharp = require("sharp");
const path = require("path");
const fs = require("fs");

function onIssuePhotoUploaded({ admin }) {
  return onObjectFinalized(async (event) => {
    const file = event.data;
    const name = file.name || ""; // issues/{farmId}/{issueId}/original/{filename}
    if (!name.startsWith("issues/")) return;
    if (!name.includes("/original/")) return;
    if (name.includes("/thumb/")) return;

    const parts = name.split("/"); // ["issues", farmId, issueId, "original", filename]
    const farmId = parts[1], issueId = parts[2];
    const bucket = admin.storage().bucket(file.bucket);

    const tmp = `/tmp/${Date.now()}-${path.basename(name)}`;
    await bucket.file(name).download({ destination: tmp });

    const meta = await sharp(tmp).metadata();
    const thumbBuf = await sharp(tmp).rotate()
      .resize(1024, 1024, { fit: "inside" })
      .jpeg({ quality: 82 }).toBuffer();
    const thumbPath = name.replace("/original/", "/thumb/").replace(/\.[^.]+$/, ".jpg");
    await bucket.file(thumbPath).save(thumbBuf, { contentType: "image/jpeg" });

    fs.unlink(tmp, () => {});

    const db = admin.firestore();
    await db.collection("farm_issues").doc(issueId).update({
      photos: admin.firestore.FieldValue.arrayUnion(
        { path: name, width: meta.width || null, height: meta.height || null, ts: Date.now() },
        { path: thumbPath, width: null, height: null, kind: "thumb", ts: Date.now() }
      ),
      revision: admin.firestore.FieldValue.increment(1)
    });
  });
}

module.exports = { onIssuePhotoUploaded };
