import caporal = require("caporal");
import * as fs from "fs";
import * as readline from "readline";
import * as path from "path";

async function download(
  videoOrChannel: string,
  config: { archive: string; meta: string; temporary: string }
): Promise<void> {
  //TODO:
  return Promise.resolve();
}

/*
 ${destination}
   |- archive
   |   |- ${video_id}.mp4
   |   |- ...
   |- meta
   |   |- all.txt
   |   |- ${video_id}.info.json
   |- link
   |   |- byChannel
   |   |   `- ${channel_name}
   |   |       `- ${year}${month}${day}_${video_title}.mp4 (link to archive/${video_id}.mp4)
   |   `- byDate
   |       `- ${year}
   |           `- ${month}
   |               `- ${day}_${channel_name}_${video_title}.mp4 (link to archive/${video_id}.mp4)
   `- .temporary
       `- .${video_id}
           |- ${video_id}.f137.mp4.part
           `- ${video_id}.f251.webm.part
*/

caporal
  .command("start", "")
  .option(
    "--destination <directory>",
    "Archive destination directory",
    caporal.STRING
  )
  .action(async (args, options, logger) => {
    const destination = options["destination"];
    if (!destination) {
      throw new Error("--destination not specified");
    }
    const stat = await fs.promises.stat(destination);
    if (!stat) {
      throw new Error(`directory "${destination}" does not exist`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`${destination} is not a directory`);
    }
    const archive = path.join(destination, "archive");
    const meta = path.join(destination, "meta");
    const temporary = path.join(destination, ".temporary");
    for (const dir of [archive, meta, temporary]) {
      await fs.promises.mkdir(dir, { recursive: true });
    }
    const videos: string[] = [];
    const rl = readline.createInterface(process.stdin);
    rl.on("line", (line) => {
      videos.push(line);
    });
    rl.on("close", async () => {
      for (const id of videos) {
        await download(id, { archive, meta, temporary });
      }
    });
  });

caporal.parse(process.argv);
