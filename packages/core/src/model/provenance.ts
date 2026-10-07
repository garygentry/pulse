/** Source location of a model element, sufficient for a finding to name the file and
 *  field (REQ-MODEL-03). All fields are deterministic — relative paths only, no absolute
 *  paths, timestamps, or PIDs (REQ-DET-01). */
export interface Provenance {
  /** Source file, **relative to the loaded directory** (deterministic). */
  file: string;
  /** YAML field path in snake_case dotted form, e.g. "hosts[2].exporter_ports". */
  path: string;
  /** 1-based line in the source file. */
  line: number;
  /** 1-based column in the source file. */
  col: number;
}
