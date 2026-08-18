import CDP from "chrome-remote-interface";
import type { Config } from "../../config/loader.js";
import { getOutputDir } from "../../config/loader.js";
import fs from "fs";
import path from "path";
import { logAction } from "../../audit/logger.js";

export interface OfficeListOptions {}

export interface OfficeListResult {
  success: boolean;
  files: {
    filename: string;
    size: number;
    created_at: string;
    extension: string;
  }[];
  directory: string;
}

export async function browserOfficeList(
  session: CDP.Client,
  options: OfficeListOptions,
  config: Config
): Promise<OfficeListResult> {
  const downloadDir = getOutputDir("downloads", config);
  
  if (!fs.existsSync(downloadDir)) {
    return {
      success: true,
      files: [],
      directory: downloadDir,
    };
  }

  const files = fs.readdirSync(downloadDir);
  const resultFiles = [];

  for (const file of files) {
    const fullPath = path.join(downloadDir, file);
    try {
      const stats = fs.statSync(fullPath);
      if (stats.isFile()) {
        resultFiles.push({
          filename: file,
          size: stats.size,
          created_at: stats.birthtime.toISOString(),
          extension: path.extname(file).toLowerCase(),
        });
      }
    } catch {
      // Ignore files that can't be statted
    }
  }

  // Sort by newest first
  resultFiles.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  logAction("browser_office_list", "read", `Listed ${resultFiles.length} files in downloads`);

  return {
    success: true,
    files: resultFiles,
    directory: downloadDir,
  };
}
