import caporal = require("caporal");
import * as fs from "fs";
import * as readline from "readline";
import * as path from "path";
import * as child_process from "child_process";
import * as glob from "glob";
import sanitize = require("sanitize-filename");
import * as os from "os";

type DownloadConfig = {
  archive: string;
  meta: string;
  link: string;
  temporary: string;
  archiveListFile: string; // youtube-dl tries to lock all.txt. This fails with smb and nfs, so put all.txt in tmp during execution
};

const kRegChannelUrl = new RegExp("^https://www.youtube.com/channel/([^/]*)$");
const kRegVideoUrl = new RegExp("^https://www.youtube.com/watch\\?v=(.*)$");
const kRegYouTubeSaid = new RegExp("^.*YouTube said: (.*)$", "m");

class CriticalError extends Error {}
class InfoParseError extends CriticalError {
  constructor(readonly videoId) {
    super(`${videoId}.info.json parse error`);
  }
}
class MultipleVideoFoundError extends CriticalError {
  constructor(readonly videoId, readonly numVideoFiles: number) {
    super(`${numVideoFiles} video files found for videoId: ${videoId}`);
  }
}
class InvalidUrlError extends CriticalError {
  constructor(readonly url) {
    super(`${url} is not a YouTube url`);
  }
}

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

  throw new InvalidUrlError(url);
}

async function downloadChannel(
  channelId: string,
  config: DownloadConfig
): Promise<void> {
  const { archive, meta, archiveListFile, temporary } = config;
  const url = `https://www.youtube.com/channel/${channelId}`;
  const d = path.join(temporary, `${channelId}`);
  await mkdirp(d);
  await new Promise((resolve, reject) => {
    const p = child_process.spawn(
      `youtube-dl "${url}" --download-archive "${archiveListFile}" --write-info-json --socket-timeout=20 --id --playlist-reverse`,
      { shell: true, cwd: d, stdio: "inherit" }
    );
    p.on("error", (e) => {
      reject(e);
    });
    p.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject();
      }
    });
    process.on("SIGINT", (sig) => p.kill(sig));
    process.on("SIGTERM", (sig) => p.kill(sig));
  }).catch(console.error);
  for await (const file of await fs.promises.opendir(d)) {
    if (!file.isFile()) {
      continue;
    }
    if (!file.name.endsWith(".info.json")) {
      continue;
    }
    const infoFullName = path.join(d, file.name);
    const infoDestination = path.join(meta, file.name);
    const videoId = file.name.substr(0, file.name.length - ".info.json".length);
    const videoFullName = await findVideoFile(videoId, d);
    if (!videoFullName) {
      continue;
    }
    const videoDestination = path.join(archive, path.basename(videoFullName));
    await fs.promises.rename(infoFullName, infoDestination);
    await fs.promises.rename(videoFullName, videoDestination);
  }
  await fs.promises.rmdir(d, { recursive: true });
}

async function downloadVideo(
  videoId: string,
  config: DownloadConfig
): Promise<void> {
  const archivePath =
    (await findVideoFile(videoId, config.archive)) ??
    (await spawnDownloader(videoId, config));
  if (archivePath) {
    await createLink(videoId, archivePath, config);
  }
}

async function spawnDownloader(
  videoId: string,
  config: DownloadConfig
): Promise<string | undefined> {
  const { archive, meta, archiveListFile, temporary } = config;
  const d = path.join(temporary, `${videoId}`);
  await mkdirp(d);
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  await new Promise((resolve, reject) => {
    let youtubeSaidSomething = "";
    const p = child_process.spawn(
      `youtube-dl "${url}" --download-archive "${archiveListFile}" --write-info-json --socket-timeout=20 --id`,
      { cwd: d, shell: true }
    );
    p.on("error", (e) => {
      if (e) {
        console.error(e);
      }
      reject(e);
    });
    p.on("exit", async (code) => {
      if (code !== 0) {
        if (youtubeSaidSomething) {
          await fs.promises.appendFile(
            archiveListFile,
            `# {id=${videoId}, date=${new Date().toISOString()}} YouTube said: ${youtubeSaidSomething}\nyoutube ${videoId}\n`
          );
          resolve();
        } else {
          reject();
        }
      } else {
        resolve();
      }
    });
    p.stderr.on("data", (chunk: Buffer) => {
      const data = chunk.toString("utf-8");
      const match = kRegYouTubeSaid.exec(data);
      if (match) {
        youtubeSaidSomething = match[1];
      }
      console.error(chunk.toString("utf-8").trimRight());
    });
    p.stdout.pipe(process.stdout);
    process.on("SIGINT", (sig) => p.kill(sig));
    process.on("SIGTERM", (sig) => p.kill(sig));
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

function findVideoFile(videoId, dir: string): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    glob(path.join(dir, `${videoId}.*`), (err, matches: string[]) => {
      if (err) {
        reject();
        return;
      }
      const files = matches.filter((it) => !it.endsWith(".info.json"));
      if (files.length === 1) {
        resolve(files[0]);
      } else if (files.length === 0) {
        resolve(undefined);
      } else {
        reject(new MultipleVideoFoundError(videoId, files.length));
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
  let info;
  try {
    info = JSON.parse(json);
  } catch (e) {
    throw new InfoParseError(videoId);
  }
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
  await fsLink(archivePath, byChannelDir, {
    leading: `${upload_date}_`,
    main: fulltitle,
    trailing: `_${videoId}${ext}`,
  });
  await fsLink(archivePath, byDateDir, {
    leading: `${day}_${uploader}_`,
    main: fulltitle,
    trailing: `_${videoId}${ext}`,
  });
}

async function fsExists(p: string): Promise<boolean> {
  try {
    await fs.promises.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function fsLink(
  existingPath: string,
  dir: string,
  filename: { leading: string; main: string; trailing: string }
): Promise<void> {
  const { leading, main, trailing } = filename;
  let current = main;
  while (true) {
    const newPath = path.join(dir, `${leading}${current}${trailing}`);
    if (await fsExists(newPath)) {
      break;
    }
    try {
      await fs.promises.link(existingPath, newPath);
      break;
    } catch (e) {
      if (e.code === "ENAMETOOLONG") {
        current = current.substr(0, current.length - 1);
      } else {
        throw e;
      }
    }
  }
}

async function action(
  urls: string[],
  config: DownloadConfig
): Promise<{ next: string[]; ok: boolean }> {
  let caughtError = false;
  const next: string[] = [];
  for (const url of urls) {
    await download(url, config).catch((e) => {
      console.error(e);
      if (e instanceof CriticalError) {
        process.exit(1);
      }
      caughtError = true;
      next.push(url);
    });
  }
  return { next, ok: caughtError === false };
}

async function isFileSystemLockable(s: string): Promise<boolean> {
  if (process.platform === "darwin") {
    return new Promise((resolve, reject) => {
      const df = child_process.spawn("df", [s]);
      const tail = child_process.spawn("tail", ["-1"]);
      const awk = child_process.spawn("awk", ["{print $1}"]);
      df.stdout.pipe(tail.stdin);
      tail.stdout.pipe(awk.stdin);
      let filesystem = "";
      awk.stdout.on("data", (chunk: Buffer) => {
        filesystem += chunk.toString("utf-8");
      });
      awk.on("exit", () => {
        filesystem = filesystem.trim();
        const mount = child_process.spawn("mount");
        const grep = child_process.spawn("grep", [`${filesystem}`]);
        mount.stdout.pipe(grep.stdin);
        let out = "";
        grep.stdout.on("data", (chunk: Buffer) => {
          out += chunk.toString("utf-8");
        });
        grep.on("exit", (code) => {
          if (code === 0) {
            out = out.trim();
            const m = out.match(/^.*\(([a-z]*), .*\).*$/);
            if (m) {
              const type = m[1];
              if (type === "nfs" || type === "smbfs") {
                resolve(false);
              } else if (type === "apfs") {
                resolve(true);
              } else {
                console.warn(`unknown file system: "${type}"`);
                resolve(true);
              }
            } else {
              reject();
            }
          } else {
            reject();
          }
        });

        mount.on("error", reject);
        grep.on("error", reject);
      });

      df.on("error", reject);
      tail.on("error", reject);
      awk.on("error", reject);
    });
  } else {
    return true;
  }
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
    const temporary = path.join(destination, "temporary");
    const link = path.join(destination, "link");
    for (const dir of [archive, meta, temporary, link]) {
      await mkdirp(dir);
    }
    const defaultArchiveFileList = path.join(path.resolve(meta), "all.txt");
    let archiveListFile = defaultArchiveFileList;
    let tempdir: string | undefined;
    if (!(await isFileSystemLockable(path.resolve(meta)))) {
      tempdir = await fs.promises.mkdtemp(os.tmpdir());
      archiveListFile = path.join(tempdir, "all.txt");
    }
    const config: DownloadConfig = {
      archive: path.resolve(archive),
      meta: path.resolve(meta),
      link: path.resolve(link),
      temporary: path.resolve(temporary),
      archiveListFile,
    };
    const urls: string[] = [];
    const rl = readline.createInterface(process.stdin);
    rl.on("line", (line) => {
      urls.push(line);
    });
    rl.on("close", async () => {
      if (archiveListFile !== defaultArchiveFileList) {
        await fs.promises.copyFile(defaultArchiveFileList, archiveListFile);
      }
      let list = urls;
      while (true) {
        const { ok, next } = await action(list, config);
        if (ok) {
          break;
        }
        list = next;
      }
      if (archiveListFile !== defaultArchiveFileList) {
        await fs.promises.copyFile(archiveListFile, defaultArchiveFileList);
      }
      if (tempdir) {
        await fs.promises.rmdir(tempdir, { recursive: true });
      }
    });
  });

caporal.parse(process.argv);
