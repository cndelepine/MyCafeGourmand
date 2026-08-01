import { recipeRecordSchema } from "../schema";

export const meatballsSoup = recipeRecordSchema.parse({
  schemaVersion: 1,
  kind: "recipe",
  id: "wordpress:wprm:2980",
  locale: "en",
  translationGroupId: null,
  slug: "meatballs-soup",
  source: {
    system: "wordpress",
    postId: null,
    recipeId: "2980",
    postType: null,
    plugin: "wprm",
    sourceSlug: null,
    createdAt: null,
    modifiedAt: null
  },
  legacyUrls: [],
  title: "Meatballs Soup",
  description: "A comforting, dill-scented soup with tender meatballs, potatoes, rice, and a simple vegetable broth.",
  editorial: {
    content: null,
    excerpt: null
  },
  taxonomies: [
    {
      taxonomy: "category",
      sourceId: null,
      name: "Soups",
      slug: "soups"
    }
  ],
  recipe: {
    servings: {
      raw: "5–6 servings",
      min: 5,
      max: 6,
      unit: "servings",
      scalable: true
    },
    times: {
      prep: {
        raw: "30 minutes",
        minutes: 30
      },
      cook: null,
      rest: null,
      total: null
    },
    heroMediaId: "hero",
    ingredientGroups: [
      {
        name: "Meatballs",
        sourceIndex: 0,
        items: [
          { sourceIndex: 0, raw: "½ lb ground turkey", quantity: null, name: "½ lb ground turkey", notes: null },
          { sourceIndex: 1, raw: "½ lb ground beef", quantity: null, name: "½ lb ground beef", notes: null },
          { sourceIndex: 2, raw: "½ onion, finely diced", quantity: null, name: "½ onion, finely diced", notes: null },
          { sourceIndex: 3, raw: "Salt, to taste", quantity: null, name: "Salt, to taste", notes: null }
        ]
      },
      {
        name: "Soup",
        sourceIndex: 1,
        items: [
          { sourceIndex: 0, raw: "10 cups water", quantity: null, name: "10 cups water", notes: null },
          { sourceIndex: 1, raw: "3 Tbsp chicken bouillon paste (optional)", quantity: null, name: "3 Tbsp chicken bouillon paste (optional)", notes: null },
          { sourceIndex: 2, raw: "5 medium potatoes, cubed", quantity: null, name: "5 medium potatoes, cubed", notes: null },
          { sourceIndex: 3, raw: "½ medium onion, finely diced", quantity: null, name: "½ medium onion, finely diced", notes: null },
          { sourceIndex: 4, raw: "3 Tbsp rice", quantity: null, name: "3 Tbsp rice", notes: null },
          { sourceIndex: 5, raw: "2 Tbsp olive oil", quantity: null, name: "2 Tbsp olive oil", notes: null },
          { sourceIndex: 6, raw: "1 large carrot, shredded", quantity: null, name: "1 large carrot, shredded", notes: null },
          { sourceIndex: 7, raw: "½ cup fresh dill and parsley, chopped", quantity: null, name: "½ cup fresh dill and parsley, chopped", notes: null }
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
            text: "Place the ground turkey and beef in a bowl. Add the chopped onion and salt, mix well, then roll the mixture into small meatballs.",
            mediaId: "step-1"
          },
          {
            sourceIndex: 1,
            text: "Bring the water to a boil in a medium pot. Add the chicken bouillon paste, if using, and the potatoes.",
            mediaId: null
          },
          {
            sourceIndex: 2,
            text: "Add the remaining onion and rice. Gently lower the meatballs into the pot, one at a time.",
            mediaId: null
          },
          {
            sourceIndex: 3,
            text: "Cook for about 15 minutes, or until the meatballs float to the surface.",
            mediaId: null
          },
          {
            sourceIndex: 4,
            text: "Meanwhile, warm the olive oil in a small skillet. Sauté the shredded carrot for about 2 minutes, then add it to the soup.",
            mediaId: null
          },
          {
            sourceIndex: 5,
            text: "Boil for 3 more minutes. Stir in the dill and parsley just before serving. Serve with sour cream, if you like.",
            mediaId: null
          }
        ]
      }
    ]
  },
  media: [
    {
      id: "hero",
      sourceId: null,
      path: "/recipes/meatballs-soup/hero.png",
      alt: "A bowl of meatball soup",
      width: 800,
      height: 592
    },
    {
      id: "step-1",
      sourceId: null,
      path: "/recipes/meatballs-soup/steps/01-meatball-mix.png",
      alt: "Ground meat and onion mixture prepared for shaping into meatballs",
      width: 800,
      height: 592
    }
  ],
  seo: null
});
