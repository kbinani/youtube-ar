import caporal = require("caporal");
import { downloadAction } from "./src/download";

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
   |   |       `- ${year}${month}${day}_${video_title}_${video_id}.mp4 (link to archive/${video_id}.mp4)
   |   `- byDate
   |       `- ${year}
   |           `- ${month}
   |               `- ${day}_${channel_name}_${video_title}_${video_id}.mp4 (link to archive/${video_id}.mp4)
   `- temporary
       `- ${video_id}
           |- ${video_id}.f137.mp4.part
           `- ${video_id}.f251.webm.part
*/

caporal
  .command("download", "")
  .option(
    "--destination <directory>",
    "Archive destination directory",
    caporal.STRING,
    undefined,
    true
  )
  .action(downloadAction);

caporal.parse(process.argv);
