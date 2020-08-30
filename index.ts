import caporal = require("caporal");
import * as fs from "fs";
import * as readline from "readline";
import * as path from "path";
import * as child_process from "child_process";
import * as glob from "glob";
import sanitize = require("sanitize-filename");

type DownloadConfig = {
  archive: string;
  meta: string;
  link: string;
  temporary: string;
};

const kRegChannelUrl = new RegExp("^https://www.youtube.com/channel/([^/]*)$");
const kRegVideoUrl = new RegExp("^https://www.youtube.com/watch\\?v=(.*)$");

async function mkdirp(d: string): Promise<void> {
  await fs.promises.mkdir(d, { recursive: true });
}

async function download(url: string, config: DownloadConfig): Promise<void> {
  const channelMatch = kRegChannelUrl.exec(url);
  if (channelMatch) {
    const channelId = channelMatch[1];
    return await downloadChannel(channelId, config);
  }

  const videoMatch = kRegVideoUrl.exec(url);
  if (videoMatch) {
    const videoId = videoMatch[1];
    return await downloadVideo(videoId, config);
  }

  console.warn(`url: "${url}" is not a YouTube url`);
  return Promise.resolve();
}

async function downloadChannel(
  channelId: string,
  config: DownloadConfig
): Promise<void> {
  const { meta } = config;
  const url = `https://www.youtube.com/channel/${channelId}`;
  const list = path.join(meta, "all.txt");
  const ids = await new Promise<string[]>((resolve, reject) => {
    const p = child_process.spawn(
      `youtube-dl --get-id --download-archive "${list}" --playlist-reverse "${url}"`,
      { shell: true }
    );
    let stdout = "";
    p.on("error", reject);
    p.on("exit", (code) => {
      if (code !== 0) {
        reject();
      } else {
        resolve(
          stdout
            .split("\n")
            .map((it) => it.trim())
            .filter((it) => it.length > 0)
        );
      }
    });
    p.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
  });
  for (const videoId of ids) {
    await downloadVideo(videoId, config);
  }
}

async function downloadVideo(
  videoId: string,
  config: DownloadConfig
): Promise<void> {
  const archivePath =
    (await findVideoFile(videoId, config)) ??
    (await spawnDownloader(videoId, config));
  if (archivePath) {
    await createLink(videoId, archivePath, config);
  }
}

async function spawnDownloader(
  videoId: string,
  config: DownloadConfig
): Promise<string | undefined> {
  const { archive, meta, temporary } = config;
  const d = path.join(temporary, `.${videoId}`);
  await mkdirp(d);
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const list = path.join(meta, "all.txt");
  await new Promise((resolve, reject) => {
    const p = child_process.spawn(
      `youtube-dl "${url}" --download-archive "${list}" --write-info-json --socket-timeout=20 --id`,
      { cwd: d, stdio: "inherit", shell: true }
    );
    p.on("error", (e) => {
      reject();
    });
    p.on("exit", (code) => {
      if (code !== 0) {
        reject();
      } else {
        resolve();
      }
    });
  });
  let archivePath: string | undefined;
  for await (const file of await fs.promises.opendir(d)) {
    if (!file.isFile()) {
      continue;
    }
    const fullname = path.join(d, file.name);
    if (file.name.endsWith(".info.json")) {
      const destination = path.join(meta, file.name);
      await fs.promises.rename(fullname, destination);
    } else if (!archivePath) {
      const destination = path.join(archive, file.name);
      archivePath = destination;
      await fs.promises.rename(fullname, destination);
    }
  }
  await fs.promises.rmdir(d, { recursive: true });
  return archivePath;
}

async function findVideoFile(
  videoId,
  config: DownloadConfig
): Promise<string | undefined> {
  const { archive } = config;
  return new Promise((resolve, reject) => {
    glob(path.join(archive, `${videoId}.*`), (err, matches: string[]) => {
      if (err) {
        reject();
        return;
      }
      if (matches.length === 1) {
        resolve(matches[0]);
      } else {
        resolve(undefined);
      }
    });
  });
}

async function createLink(
  videoId: string,
  archivePath: string,
  config: DownloadConfig
): Promise<void> {
  const { meta, link } = config;
  const json: string = (
    await fs.promises.readFile(path.join(meta, `${videoId}.info.json`))
  ).toString("utf-8");
  const info = JSON.parse(json);
  const upload_date: string = info["upload_date"]; // yyyymmdd
  const fulltitle: string = sanitize(info["fulltitle"]);
  const uploader: string = sanitize(info["uploader"]); // === channel_name
  const year = upload_date.substr(0, 4);
  const month = upload_date.substr(4, 2);
  const day = upload_date.substr(6, 2);
  const ext = path.extname(archivePath);
  const byChannelDir = path.join(link, "byChannel", uploader);
  const byDateDir = path.join(link, "byDate", year, month);
  await mkdirp(byChannelDir);
  await mkdirp(byDateDir);
  const linkByChannel = path.join(
    byChannelDir,
    `${upload_date}_${fulltitle}_${videoId}${ext}`
  );
  const linkByDate = path.join(
    byDateDir,
    `${day}_${uploader}_${fulltitle}_${videoId}${ext}`
  );
  for await (const linkDestination of [linkByChannel, linkByDate]) {
    await fs.promises.stat(linkDestination).catch(() => {
      return fs.promises.link(archivePath, linkDestination);
    });
  }
}

async function action(urls: string[], config: DownloadConfig): Promise<boolean> {
  let caughtError = false;
  for (const url of urls) {
    await download(url, config).catch(e => {
      console.error(e);
      caughtError = true;
    });
  }
  return caughtError === false;
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
   |   |       `- ${year}${month}${day}_${video_title}_${video_id}.mp4 (link to archive/${video_id}.mp4)
   |   `- byDate
   |       `- ${year}
   |           `- ${month}
   |               `- ${day}_${channel_name}_${video_title}_${video_id}.mp4 (link to archive/${video_id}.mp4)
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
    caporal.STRING,
    undefined,
    true
  )
  .action(async (args, options, logger) => {
    const destination = options["destination"];
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
    const link = path.join(destination, "link");
    for (const dir of [archive, meta, temporary, link]) {
      await mkdirp(dir);
    }
    const config: DownloadConfig = {
      archive: path.resolve(archive),
      meta: path.resolve(meta),
      link: path.resolve(link),
      temporary: path.resolve(temporary),
    };
    const urls: string[] = [];
    const rl = readline.createInterface(process.stdin);
    rl.on("line", (line) => {
      urls.push(line);
    });
    rl.on("close", async () => {
      while (!(await action(urls, config)));
    });
  });

caporal.parse(process.argv);
