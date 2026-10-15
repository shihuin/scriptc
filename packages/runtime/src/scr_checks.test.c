/* Guard-fallback counters (`scr_runtime.h`, `scr_object.c`, `scr_console.c`),
 * driven the way emitted code drives them: count a few fallbacks of each
 * kind, then let the exit hook report them.
 *
 * The report is gated on `SCRIPTC_CHECK_STATS=1`, so this driver runs twice
 * (scr_checks.test.ts). Without the variable stderr must stay empty — the
 * differential lanes compare it byte for byte — and with it the line must
 * report exactly what was counted, which is what makes the counter evidence
 * rather than an assertion that it exists. */
#undef NDEBUG
#include "scr_runtime.h"
#include <assert.h>
#include <stdio.h>

int main(void) {
  scr_init();
  /* An out-of-range kind is ignored rather than written out of bounds: the
   * emitter and this table must never be able to corrupt memory. */
  scr_check_note(-1);
  scr_check_note(4);
  scr_check_note(999);
  assert(scr_check_count(-1) == 0);
  assert(scr_check_count(4) == 0);

  scr_check_note(0); /* read  */
  scr_check_note(0); /* read  */
  scr_check_note(1); /* state */
  scr_check_note(3); /* push  */
  assert(scr_check_count(0) == 2);
  assert(scr_check_count(1) == 1);
  assert(scr_check_count(2) == 0);
  assert(scr_check_count(3) == 1);

  printf("counted\n");
  return 0;
}
