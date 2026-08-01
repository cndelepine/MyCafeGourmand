export type IngredientGroup = {
  name: string;
  items: string[];
};

export type Recipe = {
  id: string;
  language: "en" | "fr" | "ru";
  title: string;
  description: string;
  category: string;
  servings: string;
  prepTime: string;
  images: {
    hero: string;
    steps: Record<number, string>;
  };
  ingredients: IngredientGroup[];
  steps: string[];
};

// Imported from the WordPress backup (recipe ID 2980). Keeping recipe content
// in the project makes the site fully static and easy to version-control.
export const meatballsSoup: Recipe = {
  id: "meatballs-soup",
  language: "en",
  title: "Meatballs Soup",
  description: "A comforting, dill-scented soup with tender meatballs, potatoes, rice, and a simple vegetable broth.",
  category: "Soups",
  servings: "5–6 servings",
  prepTime: "30 minutes",
  images: {
    hero: "/recipes/meatballs-soup/hero.png",
    steps: {
      0: "/recipes/meatballs-soup/steps/01-meatball-mix.png"
    }
  },
  ingredients: [
    {
      name: "Meatballs",
      items: [
        "½ lb ground turkey",
        "½ lb ground beef",
        "½ onion, finely diced",
        "Salt, to taste"
      ]
    },
    {
      name: "Soup",
      items: [
        "10 cups water",
        "3 Tbsp chicken bouillon paste (optional)",
        "5 medium potatoes, cubed",
        "½ medium onion, finely diced",
        "3 Tbsp rice",
        "2 Tbsp olive oil",
        "1 large carrot, shredded",
        "½ cup fresh dill and parsley, chopped"
      ]
    }
  ],
  steps: [
    "Place the ground turkey and beef in a bowl. Add the chopped onion and salt, mix well, then roll the mixture into small meatballs.",
    "Bring the water to a boil in a medium pot. Add the chicken bouillon paste, if using, and the potatoes.",
    "Add the remaining onion and rice. Gently lower the meatballs into the pot, one at a time.",
    "Cook for about 15 minutes, or until the meatballs float to the surface.",
    "Meanwhile, warm the olive oil in a small skillet. Sauté the shredded carrot for about 2 minutes, then add it to the soup.",
    "Boil for 3 more minutes. Stir in the dill and parsley just before serving. Serve with sour cream, if you like."
  ]
};
