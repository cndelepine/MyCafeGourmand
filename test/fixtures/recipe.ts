import { recipeRecordSchema, type RecipeRecord } from "../../src/content/schema";

export const recipeFixture: RecipeRecord = recipeRecordSchema.parse({
  schemaVersion: 1,
  kind: "recipe",
  id: "test:recipe:1",
  locale: "en",
  translationGroupId: null,
  slug: "fixture-recipe",
  source: {
    system: "wordpress",
    postId: null,
    recipeId: "1",
    postType: null,
    plugin: "wprm",
    sourceSlug: "fixture-recipe",
    createdAt: null,
    modifiedAt: null,
    editorialPostId: null,
    editorialPostType: null,
    editorialSourceSlug: null,
    editorialCreatedAt: null,
    editorialModifiedAt: null
  },
  redirectFrom: [],
  title: "Fixture Recipe",
  description: "A sanitized fixture recipe.",
  editorial: {
    content: "<p>Sanitized fixture content.</p>",
    excerpt: "Sanitized fixture excerpt."
  },
  taxonomies: [
    {
      scope: "recipe",
      taxonomy: "category",
      sourceId: null,
      sourceTaxonomyId: null,
      name: "Fixture Recipes",
      slug: "fixture-recipes"
    }
  ],
  recipe: {
    notes: null,
    servings: {
      raw: "5–6 servings",
      min: 5,
      max: 6,
      unit: "servings",
      scalable: true
    },
    times: {
      prep: { raw: "30 minutes", minutes: 30 },
      cook: null,
      rest: null,
      total: { raw: "30 minutes", minutes: 30 },
      custom: null
    },
    heroMediaId: "hero",
    ingredientGroups: [
      {
        name: null,
        sourceIndex: 0,
        items: [
          {
            sourceIndex: 0,
            raw: "½ lb ground turkey",
            quantity: {
              raw: "½ lb",
              value: 0.5,
              unit: "lb",
              scalable: true
            },
            name: "ground turkey",
            notes: null
          },
          {
            sourceIndex: 1,
            raw: "1 cup breadcrumbs",
            quantity: {
              raw: "1 cup",
              value: 1,
              unit: "cup",
              scalable: true
            },
            name: "breadcrumbs",
            notes: null
          },
          {
            sourceIndex: 2,
            raw: "½ onion, finely diced",
            quantity: {
              raw: "½",
              value: 0.5,
              unit: null,
              scalable: true
            },
            name: "onion",
            pluralName: "onions",
            notes: "finely diced"
          },
          {
            sourceIndex: 3,
            raw: "Salt, to taste",
            quantity: null,
            name: "Salt",
            notes: "to taste"
          },
          {
            sourceIndex: 4,
            raw: "1 egg",
            quantity: {
              raw: "1",
              value: 1,
              unit: null,
              scalable: true
            },
            name: "egg",
            notes: null
          },
          {
            sourceIndex: 5,
            raw: "1 Tbsp chicken bouillon paste (optional)",
            quantity: {
              raw: "1 Tbsp",
              value: 1,
              unit: "Tbsp",
              scalable: true
            },
            name: "chicken bouillon paste",
            notes: "optional"
          },
          {
            sourceIndex: 6,
            raw: "1 clove garlic",
            quantity: {
              raw: "1",
              value: 1,
              unit: null,
              scalable: true
            },
            name: "clove garlic",
            notes: null
          },
          {
            sourceIndex: 7,
            raw: "1 cup broth",
            quantity: {
              raw: "1 cup",
              value: 1,
              unit: "cup",
              scalable: true
            },
            name: "broth",
            notes: null
          },
          {
            sourceIndex: 8,
            raw: "½ tsp pepper",
            quantity: {
              raw: "½ tsp",
              value: 0.5,
              unit: "tsp",
              scalable: true
            },
            name: "pepper",
            notes: null
          },
          {
            sourceIndex: 9,
            raw: "2 slices bread",
            quantity: {
              raw: "2",
              value: 2,
              unit: null,
              scalable: true
            },
            name: "slices bread",
            notes: null
          },
          {
            sourceIndex: 10,
            raw: "1 large carrot, shredded",
            quantity: {
              raw: "1 large",
              value: 1,
              unit: "large",
              scalable: true
            },
            name: "carrot",
            pluralName: "carrots",
            notes: "shredded"
          }
        ]
      }
    ],
    instructionGroups: [
      {
        name: null,
        sourceIndex: 0,
        steps: [
          {
            sourceIndex: 0,
            text: "Combine the ingredients.",
            mediaId: "step-1"
          }
        ]
      }
    ]
  },
  media: [
    {
      id: "hero",
      sourceId: null,
      path: "/recipes/fixture-recipe/hero.png",
      alt: "Sanitized fixture recipe hero",
      width: 640,
      height: 480
    },
    {
      id: "step-1",
      sourceId: null,
      path: "/recipes/fixture-recipe/steps/01.png",
      alt: "Sanitized fixture recipe step",
      width: 640,
      height: 480
    }
  ],
  seo: null
});
