/* scriptc runtime — unions and the void*-signature RC adapters (scr_union.c).
 * Included by scr_runtime.h, which says where new declarations go. */
#ifndef SCR_UNION_H
#define SCR_UNION_H

#include "scr_rc.h"

/* ── unions ─────────────────────────────────────────────────────────
 * A union value (`A | B`) is an IMMUTABLE tagged box: a refcounted header,
 * the arm's tag (its index in the compiler's canonical arm order), and one
 * 8-byte payload slot (double/bool/pointer via memcpy, like ScrBox and
 * ScrArr slots). Reassigning a union-typed variable constructs a NEW box —
 * immutability keeps the RC story trivial.
 *
 * Scalar arms (f64/bool) live in the slot with NULL RC entry points. Ref
 * arms OWN their payload (+1 moves in at construction) and carry the arm's
 * retain/release as function pointers, exactly like SCR_BOX_OBJ: the
 * runtime cannot know per-class/per-record struct layouts, so the compiler
 * supplies its emitted `_v` adapters (and the runtime provides `_v`
 * adapters for its own refcounted kinds below).
 *
 * Ownership: _new_ref takes ownership of the payload; scr_union_peek
 * BORROWS the payload pointer (the compiler retains through the arm's
 * concrete helper when it needs +1); releasing the union releases the
 * payload through the stored fn ptr.
 */

typedef struct ScrUnion {
  size_t rc; /* SIZE_MAX = immortal (unused for unions; kept per convention) */
  uint32_t tag;
  /* 1 exactly when the arm type carries a cycle header, so this box can be a
   * collector root (like ScrBox.obj_trace: the union's trace then visits the
   * payload). Kept beside the tag so scr_union_release and the inline release
   * in shapes.ts test it with one byte load in the box's first cache line,
   * never through another object. */
  uint8_t traced;
  /* Ref arms only: the arm type's `_v` release adapter; NULL for scalar arms.
   * There is one box per union value and one such adapter per arm type, which
   * is why the pointer lives here rather than in a table. The arm's retain is
   * not stored: every ref payload begins with its RC header, so the generic
   * scr_rc_retain reaches it without an adapter. */
  void (*arm_release)(void *);
  uint64_t slot; /* double/bool/pointer via memcpy and casts */
} ScrUnion;
/* The emitted IR declares `%ScrUnion = type { size_t, i32, i8, ptr, i64 }` and
 * reads `traced` right after the tag — byte 12 on 64-bit, byte 8 on wasm32.
 * The box is one 32-byte half-cache-line on 64-bit targets and 24 bytes on
 * wasm32; it was 48/32 bytes with a retain adapter and a trace pointer. */
_Static_assert(sizeof(ScrUnion) == (sizeof(size_t) == 8 ? 32 : 24),
               "ScrUnion must fit a 32-byte box on 64-bit and 24 bytes on wasm32");
_Static_assert(offsetof(ScrUnion, traced) == sizeof(size_t) + sizeof(uint32_t),
               "inline RC fast paths read ScrUnion.traced right after the tag");
_Static_assert(offsetof(ScrUnion, arm_release) ==
                   (offsetof(ScrUnion, traced) + sizeof(uint8_t) + _Alignof(void *) - 1) /
                           _Alignof(void *) *
                       _Alignof(void *),
               "arm_release follows the tag, the traced byte and their padding");

ScrUnion *scr_union_new_f64(uint32_t tag, double v);  /* returns +1 */
ScrUnion *scr_union_new_bool(uint32_t tag, bool v);   /* returns +1 */
/* Takes ownership of v (+1 moves in); release must be non-NULL; traced is 1
 * iff the arm type carries a cycle header. */
ScrUnion *scr_union_new_ref(uint32_t tag, void *v,
                             void (*release)(void *),
                             uint8_t traced);

static inline ScrUnion *scr_union_retain(ScrUnion *u) {
  if (u->rc != SIZE_MAX) {
    u->rc++;
  }
  return u;
}

void scr_union_release(ScrUnion *u); /* releases a ref payload; NULL-tolerant */

double scr_union_get_f64(ScrUnion *u);
bool scr_union_get_bool(ScrUnion *u);

/* BORROWED payload pointer of a ref arm (no ownership change). */
static inline void *scr_union_peek(const ScrUnion *u) {
  void *p;
  memcpy(&p, &u->slot, sizeof p);
  return p;
}

/* void*-signature RC adapters for the runtime's own refcounted kinds —
 * stored in ScrUnion (ref arms) and ScrBox (SCR_BOX_OBJ-style union boxes)
 * alongside the compiler's emitted per-class/per-record `_v` adapters. */
void *scr_str_retain_v(void *s);
void scr_str_release_v(void *s);
void *scr_arr_retain_v(void *a);
void scr_arr_release_v(void *a);
void *scr_closure_retain_v(void *c);
void scr_closure_release_v(void *c);
void *scr_union_retain_v(void *u);
void scr_union_release_v(void *u);

/* Trace entry points for the runtime's cycle-headered kinds — passed
 * wherever a container stores a payload's RC entry points (ScrBox obj
 * slots, union ref arms, promise payloads, the exception cell) and the
 * payload type is one of these. The compiler passes its emitted per-shape
 * trace for cycle-capable classes/records, and NULL for acyclic types. */
void scr_closure_trace_v(void *c, ScrTraceVisit visit, void *ctx);

#endif /* SCR_UNION_H */
