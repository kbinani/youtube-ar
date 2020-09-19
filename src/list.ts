import * as fs from "fs";
import * as path from "path";
import * as child_process from "child_process";
import { findVideoFile } from "./download";
import { sprintf } from "sprintf-js";
import { ChildProcessWithoutNullStreams } from "child_process";

const kDurationDifferenceThresholdSeconds = 5;

async function listupIncomplete(params: { archive: string; meta: string }) {
  const { archive, meta } = params;
  const infos: string[] = [];
  for await (const file of await fs.promises.opendir(meta)) {
    if (!file.isFile()) {
      continue;
    }
    if (!file.name.endsWith(".info.json")) {
      continue;
    }
    infos.push(path.join(meta, file.name));
  }
  let i = 0;
  for (const info of infos) {
    const fileName = path.basename(info);
    const videoId = fileName.substr(0, fileName.length - ".info.json".length);
    let video: string;
    i++;
    process.stderr.write(
      `\r[${i}/${infos.length} ${sprintf("%.1f", (i / infos.length) * 100)}%]`
    );
    try {
      video = await findVideoFile(videoId, archive);
      if (!video) {
        continue;
      }
      const videoDuration = await getDuration(video);
      const infoJson = JSON.parse(
        (await fs.promises.readFile(info)).toString("utf-8")
      );
      const metaDuration = Number.parseFloat(infoJson["duration"]);
      const durationDifference = videoDuration - metaDuration;
      if (durationDifference < -kDurationDifferenceThresholdSeconds) {
        console.log(`https://www.youtube.com/watch?v=${videoId}`);
      }
    } catch (e) {
      console.error(e);
      console.log(`https://www.youtube.com/watch?v=${videoId}`);
      continue;
    }
  }
}

function spawn(
  command: string,
  args: string[]
): ChildProcessWithoutNullStreams {
  const p = child_process.spawn(command, args);
  const handleSignal = (sig) => {
    p.kill(sig);
    process.exit(1);
  };
  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);
  p.on("exit", () => {
    process.removeListener("SIGINT", handleSignal);
    process.removeListener("SIGTERM", handleSignal);
  });
  return p;
}

async function getDuration(file: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const p = spawn("ffprobe", [
      "-i",
      file,
      "-print_format",
      "json",
      "-show_entries",
      "format=duration",
      "-v",
      "quiet",
    ]);
    let jsonString = "";
    p.stdout.on("data", (chunk: Buffer) => {
      jsonString += chunk.toString("utf-8");
    });
    p.stderr.pipe(process.stderr);
    p.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe exit with code: ${code}; file=${file}`));
      } else {
        let json: any;
        try {
          json = JSON.parse(jsonString);
          const duration = Number.parseFloat(json["format"]?.["duration"]);
          resolve(duration);
        } catch (e) {
          reject(e);
        }
      }
    });
    p.on("error", reject);
  });
}

export async function listAction(args, options): Promise<void> {
  const { whatToListup } = args;
  if (!whatToListup) {
    throw new Error("argument not specified");
  }
  const destination = options["destination"];
  const stat = await fs.promises.stat(destination);
  if (!stat) {
    throw new Error(`directory "${destination}" does not exist`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`${destination} is not a directory`);
  }
  const dest = path.resolve(destination);
  const archive = path.join(dest, "archive");
  const meta = path.join(dest, "meta");
  switch (whatToListup) {
    case "incomplete":
      await listupIncomplete({ archive, meta });
      break;
    default:
      throw new Error(`unknown argument; "${whatToListup}"`);
  }
}
