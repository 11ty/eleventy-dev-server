import { globSync } from "tinyglobby";
// this was the dependency used by chokdar before!
import picomatch from "picomatch";
import { TemplatePath } from "@11ty/eleventy-utils";

export function findFiles(patterns = []) {
  let flattened = patterns.map(pattern => {
    pattern = TemplatePath.stripLeadingDotSlash(pattern);

    if(isDynamicPattern(pattern)) {
      return globSync(pattern);
    }
    return pattern;
  }).flat();

  // Make unique
  return Array.from(new Set(flattened));
}

// via tinyglobby
export function isDynamicPattern(pattern) {
	const s = picomatch.scan(pattern);
	return s.isGlob || s.negated;
}
