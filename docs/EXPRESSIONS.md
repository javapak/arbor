# arbor expressions

The language for guards, effects, invariants, derived values and operation bodies. Queries are OCL; actions add a few statements. Like [LANGUAGE.md](LANGUAGE.md), compact enough to paste into an LLM prompt. Implemented in `@arbor/expr`: parsed, type-checked and interpreted, never turned into JavaScript.

## Queries (OCL)

```
fine > 0 and not member.blocked
self.loans->select(l | l.isOverdue())->size()
items->collect(price)->sum()
status = Status::overdue
if renewals < 3 then 'renew' else 'return' endif
let late = daysOverdue() in late > 14
```

| | |
|---|---|
| literals | `42`, `2.5`, `'text'` (or `"text"`), `true`, `false`, `null`, `Status::overdue` |
| names | a variable, else a property of `self`; `self` itself |
| navigation | `a.b`; over a collection, each item's `b`, flattened (`items.price`) |
| calls | `a.op(x)`, or `op(x)` for an operation of `self` |
| collection literals | `Set{1, 2}`, `OrderedSet{…}`, `Bag{…}`, `Sequence{…}` |
| operators, loosest first | `implies` · `or` `xor` · `and` · `=` `<>` · `<` `<=` `>` `>=` · `+` `-` · `*` `/` `div` `mod` · `not` `-` |
| `if c then a else b endif` | both branches required |
| `let x = v in e` | |
| comments | `-- to the end of the line` |

`/` gives a Real; `div` and `mod` take and give Integers. `+` also joins two strings. `and`, `or` and `implies` don't evaluate their right side when the left decides.

### Collections

A multi-valued property is a collection, its kind from `ordered` and `unique` as in UML: Set, OrderedSet, Bag, Sequence. `->` applies a collection operation; on a single value it treats it as a set of one (or none, for null), so `member->isEmpty()` asks whether there's a member.

| | gives |
|---|---|
| `size()` `count(x)` | Integer |
| `isEmpty()` `notEmpty()` `includes(x)` `excludes(x)` `includesAll(c)` `excludesAll(c)` | Boolean |
| `sum()` `min()` `max()` | a number |
| `first()` `last()` `at(i)` (ordered only, from 1) | an item |
| `asSet()` `asOrderedSet()` `asBag()` `asSequence()` | that kind |
| `including(x)` `excluding(x)` `union(c)` `reverse()` | the same kind |

Iterators take a variable and a body: `->select(l | l.fine > 0)`. Without one, bare names in the body are the item's, if it has them: `->select(fine > 0)`, `->any(oclIsKindOf(Book))`.

| | gives |
|---|---|
| `select` `reject` | the same kind |
| `collect` | a Bag (from Set or Bag) or Sequence, flattened |
| `forAll` `exists` `one` `isUnique` | Boolean |
| `any` | an item, or null |
| `sortedBy` | an OrderedSet (from Set or OrderedSet) or Sequence |
| `closure` | the items, what the body gives for each, what it gives for those, and so on, each once (a cycle ends where it comes back): a Set, or an OrderedSet from an ordered collection. `general->closure(c \| c.general)` is all of a class's ancestors |

### Every value, strings, numbers

- `x.oclIsUndefined()`, `x.oclIsKindOf(T)`, `x.oclIsTypeOf(T)`, `x.oclAsType(T)`. `T` may be qualified by its profile: `uml::State`.
- Strings: `size()`, `concat(s)`, `substring(from, to)` (from 1, both ends included), `toUpper()`, `toLower()`, `indexOf(s)` (0 if absent), `toInteger()`, `toReal()`.
- Numbers: `abs()`, `floor()`, `round()`, `max(n)`, `min(n)`.

### Null

Navigating null gives null, so `member.name` is null without a member; `oclIsUndefined()` and `->isEmpty()` ask. Arithmetic or a comparison on null has no value: an evaluation error, as is a division by zero.

## Actions

A transition's effect, an entry or exit activity, an operation's body: statements separated by `;`.

```
let extra = daysOverdue() * dailyRate;
fine := fine + extra;
if fine > limit then member.blocked := true; notify(member) endif;
return fine
```

| | |
|---|---|
| `x := v` | a variable, a property of `self`, or `object.property` (not a collection's, nor a read-only or derived one) |
| `op(args)` | any operation, including those that change things |
| `if c then … else … endif` | `else` optional |
| `let x = v` | for the statements after it; it can be assigned to |
| `return v` | in an operation with a result, on every path |

A query can't assign or call an operation that changes things (EXP006): guards, invariants and derived values change nothing.

## Postconditions

`x@pre` is `x`'s value before the operation ran: `fine = fine@pre + amount`.

## Diagnostics

| Code | Meaning |
|---|---|
| EXP001 | syntax error |
| EXP002 | unknown name (with the likely one), `self` or `@pre` where there's none |
| EXP003 | unknown property, operation or enum literal, or an operation the collection doesn't have (`first` of a Set) |
| EXP004 | wrong type |
| EXP005 | wrong number of arguments |
| EXP006 | a change in a query |
| EXP007 | assigning to something that can't be assigned to |
| EXP008 | a `return` that doesn't fit the operation |

## In models

A profile types a property `expr` (a query) or `action` (statements); a model writes it as a string, in single quotes inside if it needs some: `guard: "status = Status::open and name <> ''"`.

```
kind Transition { prop guard: expr [0..1]  prop effect: action [0..1] }
```

`arbor check` parses every such slot, in any profile, and reports problems at their characters in the string (EXP001). A profile whose kinds and features play [roles](LANGUAGE.md#roles) is checked further: they say which kinds are classes, attributes, operations and parameters, which slots hold what (`plays guard`, `plays effect`, `plays body`, `plays default`), and what `self` is (the nearest `class` around, past `behavior`s). For samples/uml:

| Slot | Is | `self` |
|---|---|---|
| `Transition.guard` | a query giving a Boolean | the class owning the state machine |
| `Transition.effect`, `State.entry`, `exit`, `doActivity` | an action | the same |
| `Operation.body` | an action, or a query if `isQuery`; its parameters are variables, and it returns its `returns` type | the operation's class |
| `Property.defaultValue` | a query giving the attribute's type | the attribute's class |

A class's attributes and operations, its generals' too, are what names and calls resolve to; an attribute's type is the class or primitive type it names (`primitives.Real`: samples/uml/primitives.arbor), a collection if its multiplicity allows several (its kind from `isOrdered` and `isUnique`). An `isReadOnly` attribute can't be assigned to.

```
Class Loan {
    Property fine     { type: -> primitives.Real  defaultValue: "0.0" }
    Property renewals { type: -> primitives.Integer  defaultValue: "0" }
    Operation owes       { isQuery: true  returns: -> primitives.Boolean  body: "return fine > 0" }
    Operation chargeFine { Parameter amount { type: -> primitives.Real }  body: "fine := fine + amount" }
    ownedBehavior += StateMachine Lifecycle { … guard: "renewals < 3"  effect: "renew()" … }
}
```

## Where `self` and the types come from

The checker and interpreter work against a *type space* (classes, their properties and operations) and a *value space* (objects to read, write and call). `@arbor/expr` provides one for the model itself: `irTypeSpace` and `irValueSpace`, where the profiles' kinds are the classes and the model's elements the objects, for rules about models (`subvertices->select(oclIsKindOf(Pseudostate))->size() <= 1`): a kind's invariants, derived features and queries (see [LANGUAGE.md](LANGUAGE.md#rules-invariants-derived-features-queries)). There, a kind's queries are its operations, and `oclContainer()` gives the element holding this one; nothing can be assigned. A simulation provides one for the classes a model describes, where `self` is, say, a `Loan`.
