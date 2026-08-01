import Image from "next/image";
import type { Locale, RecipeRecord } from "@/content/schema";
import {
  getRecipeStructuredData,
  serializeRecipeStructuredData
} from "@/lib/recipe-structured-data";
import { RecipeScaling } from "./recipe-scaling";
import { SiteHeader } from "./site-header";

type RecipeViewProps = {
  recipe: RecipeRecord;
};

const copy: Record<
  Locale,
  {
    eyebrow: string;
    heading: string;
    serves: string;
    prepTime: string;
    language: string;
    ingredients: string;
    method: string;
    cook: string;
    recipe: string;
    jump: string;
    footer: string;
    missing: string;
    headingSecondLine: string;
    servingScale: string;
  }
> = {
  en: {
    eyebrow: "A recipe from the home kitchen",
    heading: "Simple ingredients.",
    serves: "Serves",
    prepTime: "Prep time",
    language: "Language",
    ingredients: "Ingredients",
    method: "Method",
    cook: "Cook this recipe",
    recipe: "Recipe",
    jump: "↓",
    footer: "Made with care, one recipe at a time.",
    missing: "Not specified",
    headingSecondLine: "A generous bowl.",
    servingScale: "Scale recipe"
  },
  fr: {
    eyebrow: "Une recette de la cuisine familiale",
    heading: "Des ingrédients simples.",
    serves: "Portions",
    prepTime: "Préparation",
    language: "Langue",
    ingredients: "Ingrédients",
    method: "Préparation",
    cook: "Cuisiner cette recette",
    recipe: "Recette",
    jump: "↓",
    footer: "Préparé avec soin, une recette à la fois.",
    missing: "Non précisé",
    headingSecondLine: "Un bol généreux.",
    servingScale: "Multiplier la recette"
  },
  ru: {
    eyebrow: "Рецепт из домашней кухни",
    heading: "Простые ингредиенты.",
    serves: "Порции",
    prepTime: "Подготовка",
    language: "Язык",
    ingredients: "Ингредиенты",
    method: "Приготовление",
    cook: "Приготовить это блюдо",
    recipe: "Рецепт",
    jump: "↓",
    footer: "С заботой, по одному рецепту за раз.",
    missing: "Не указано",
    headingSecondLine: "Щедрая миска.",
    servingScale: "Масштабировать рецепт"
  }
};

const languageNames: Record<Locale, string> = {
  en: "English",
  fr: "Français",
  ru: "Русский"
};

export function RecipeView({ recipe }: RecipeViewProps) {
  const labels = copy[recipe.locale];
  const media = new Map(recipe.media.map((asset) => [asset.id, asset]));
  const hero = recipe.recipe.heroMediaId
    ? media.get(recipe.recipe.heroMediaId)
    : undefined;
  const ingredientGroups = recipe.recipe.ingredientGroups;
  const steps = recipe.recipe.instructionGroups.flatMap((group) => group.steps);
  const recipeData = getRecipeStructuredData(recipe);

  return (
    <>
      <SiteHeader locale={recipe.locale} page="recipe" recipe={recipe} />
      <main lang={recipe.locale}>
        <section className="hero" id="top">
          <div className="hero-copy">
            <p className="eyebrow">{labels.eyebrow}</p>
            <h1>{recipe.title}</h1>
            {recipe.description ? (
              <p className="intro">{recipe.description}</p>
            ) : null}
            <a className="jump-link" href="#recipe">
              {labels.cook} <span aria-hidden="true">{labels.jump}</span>
            </a>
          </div>
          <div className="hero-art">
            {hero ? (
              <Image
                alt={hero.alt ?? ""}
                className="hero-photo"
                fill
                priority
                sizes="(max-width: 700px) 100vw, 50vw"
                src={hero.path}
              />
            ) : null}
            <div className="steam steam-one" />
            <div className="steam steam-two" />
            <div className="steam steam-three" />
            <div className="bowl">
              <i />
              <i />
              <i />
              <i />
              <i />
              <i />
            </div>
            <span className="herb herb-one">✦</span>
            <span className="herb herb-two">✦</span>
          </div>
        </section>

        <article className="recipe" id="recipe">
          <div className="recipe-heading">
            <p className="eyebrow">{recipe.taxonomies[0]?.name ?? labels.recipe}</p>
            <h2>
              {labels.heading}
              <br />
              {labels.headingSecondLine}
            </h2>
          </div>
          <RecipeScaling
            ingredientGroups={ingredientGroups}
            labels={{
              ingredients: labels.ingredients,
              language: labels.language,
              missing: labels.missing,
              prepTime: labels.prepTime,
              sectionNumber: "01",
              serves: labels.serves,
              servingScale: labels.servingScale
            }}
            language={languageNames[recipe.locale]}
            prepTime={recipe.recipe.times.prep?.raw ?? labels.missing}
            servings={recipe.recipe.servings}
          />

          <section className="method" id="method" aria-labelledby="method-title">
            <div className="section-label">
              <span>02</span>
              <h2 id="method-title">{labels.method}</h2>
            </div>
            <ol>
              {steps.map((step, index) => {
                const stepMedia = step.mediaId
                  ? media.get(step.mediaId)
                  : undefined;

                return (
                  <li key={`${step.sourceIndex}-${index}`}>
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <div>
                      <p>{step.text}</p>
                      {stepMedia ? (
                        <Image
                          alt={stepMedia.alt ?? ""}
                          className="step-photo"
                          height={stepMedia.height ?? 592}
                          src={stepMedia.path}
                          width={stepMedia.width ?? 800}
                        />
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>
        </article>
      </main>
      <footer lang={recipe.locale}>{labels.footer}</footer>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: serializeRecipeStructuredData(recipeData)
        }}
      />
    </>
  );
}
